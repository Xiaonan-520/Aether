/**
 * Cline provider adapter.
 *
 * Login is the WorkOS device-code flow, which needs **no local callback port**:
 * the gateway requests a device code, shows the operator the verification URL +
 * user code, and polls until the operator authorizes in a browser. Pending is
 * not an error (`authorization_pending`); `slow_down` backs off.
 *
 * Chat is OpenAI-compatible SSE with `Authorization: Bearer workos:<jwt>`.
 */
import type {
  Account,
  ChatChunk,
  ChatRequest,
  ChatResult,
  ModelEntry,
  ProviderCapabilities,
  QuotaSnapshot,
  Tool,
} from '../../core/types.js'
import type {
  BeginLoginResult,
  PollLoginResult,
  Provider,
  ProviderCtx,
  RefreshResult,
} from '../../core/registry/provider.js'
import { UpstreamError } from '../../core/errors/upstream-error.js'
import { decodeSseStream } from '../../protocol/openai/sse.js'
import {
  CLINE,
  CLINE_CHAT_PATH,
  CLINE_DEVICE_AUTHENTICATE_PATH,
  CLINE_DEVICE_AUTHORIZATION_PATH,
  CLINE_DEVICE_AUTH_EXPIRES_MS,
  CLINE_DEVICE_AUTH_INTERVAL_MS,
  CLINE_MODELS_PATH,
  CLINE_RECOMMENDED_MODELS_PATH,
  CLINE_REFRESH_PATH,
  CLINE_REGISTER_PATH,
  type ClineProduct,
} from './product.js'
import {
  buildClineCredential,
  classifyClinePoll,
  clineAnonymousHeaders,
  clineChatHeaders,
  clineCredentialExpiresAtMs,
  clineRefreshBody,
  isClineRefreshable,
  parseClineDeviceAuthorization,
  parseClineTokenPayload,
  type ClineCredential,
  type Fetcher,
} from './protocol.js'
import { buildClineCatalog, type ClineModel } from './models.js'
import { fetchClineBalance, toQuotaSnapshot } from './credits.js'

interface LoginSession {
  deviceCode: string
  userCode: string
  authUrl: string
  intervalMs: number
  startedAt: number
  expiresAt: number
  /** consecutive network failures (reference aborts after 5) */
  failures: number
}

const MAX_POLL_FAILURES = 5

export interface ClineProviderOptions {
  product?: ClineProduct
  fetcher?: Fetcher
  /** injected clock so tests do not need real time to pass */
  now?: () => number
}

export function createClineProvider(options: ClineProviderOptions = {}): Provider {
  const product = options.product ?? CLINE
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now
  const sessions = new Map<string, LoginSession>()

  const capabilities: ProviderCapabilities = {
    supportsOAuth: true,
    supportsRefreshToken: true,
    supportsQuota: true,
    // Cline has no daily check-in; the balance endpoint is a quota, not credits.
    supportsCredits: false,
    supportsStreaming: true,
    supportsVision: true,
    supportsToolCall: true,
    supportsMultipleAccounts: true,
    needsCaptcha: false,
    loginMode: 'device-code',
    protocol: 'openai-chat',
  }

  async function credentialOf(ctx: ProviderCtx, account: Account): Promise<ClineCredential | undefined> {
    const handle = await ctx.resolveCredential(account)
    return handle?.credential as ClineCredential | undefined
  }

  function bareModel(model: string): string {
    const sep = model.indexOf('::')
    return sep > 0 ? model.slice(sep + 2) : model
  }

  function classify(status: number, message: string): UpstreamError {
    if (status === 401 || status === 403) return new UpstreamError({ kind: 'AUTH_INVALID', status, message })
    if (status === 429) return new UpstreamError({ kind: 'RATE_LIMIT', status, message })
    if (status === 402) return new UpstreamError({ kind: 'QUOTA_EXHAUSTED', status, message })
    if (status >= 500) return new UpstreamError({ kind: 'UPSTREAM_5XX', status, message })
    return new UpstreamError({ kind: 'TERMINAL', status, message })
  }

  async function openaiChatBody(req: ChatRequest, model: string): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      stream: true,
    }
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.reasoningEffort !== undefined) body.reasoning_effort = req.reasoningEffort
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }
    return body
  }

  async function* streamChat(
    ctx: ProviderCtx,
    account: Account,
    req: ChatRequest,
  ): AsyncIterable<ChatChunk> {
    const credential = await credentialOf(ctx, account)
    if (!credential?.access_token) {
      throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'account has no Cline access token' })
    }
    const res = await fetcher(`${product.apiBase}${CLINE_CHAT_PATH}`, {
      method: 'POST',
      headers: clineChatHeaders(credential, product),
      body: JSON.stringify(await openaiChatBody(req, bareModel(req.model))),
    })
    if (!res.ok) throw classify(res.status, `Cline chat failed (HTTP ${res.status})`)
    for await (const chunk of decodeSseStream(res.body as unknown as AsyncIterable<Uint8Array>)) {
      if (chunk.text === '' && chunk.reasoning === undefined && chunk.finishReason == null && !chunk.usage) continue
      yield chunk
    }
  }

  async function aggregate(ctx: ProviderCtx, account: Account, req: ChatRequest): Promise<ChatResult> {
    let content = ''
    let reasoning = ''
    let finishReason: ChatResult['finishReason'] = 'stop'
    let usage: ChatResult['usage']
    for await (const chunk of streamChat(ctx, account, req)) {
      content += chunk.text
      if (chunk.reasoning) reasoning += chunk.reasoning
      if (chunk.finishReason) finishReason = chunk.finishReason
      if (chunk.usage) usage = chunk.usage
    }
    const result: ChatResult = { content, finishReason: finishReason ?? 'stop' }
    if (reasoning !== '') result.reasoning = reasoning
    if (usage) result.usage = usage
    return result
  }

  async function discoverCatalog(credential: ClineCredential | undefined): Promise<ClineModel[]> {
    // recommended-models needs no auth; /models needs the bearer.
    const recommendedRes = await fetcher(`${product.apiBase}${CLINE_RECOMMENDED_MODELS_PATH}`, {
      headers: clineAnonymousHeaders(product),
    })
    const recommended = recommendedRes.ok ? await recommendedRes.json().catch(() => null) : null
    let allModels: unknown = null
    if (credential?.access_token) {
      const res = await fetcher(`${product.apiBase}${CLINE_MODELS_PATH}`, {
        headers: clineAuthHeadersLocal(credential),
      })
      if (res.ok) allModels = await res.json().catch(() => null)
    }
    const catalog = buildClineCatalog({ allModels, recommended })
    return catalog
  }

  function clineAuthHeadersLocal(credential: ClineCredential): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${credential.access_token.startsWith(product.tokenPrefix) ? credential.access_token : product.tokenPrefix + credential.access_token}`,
      ...product.clientHeaders,
    }
  }

  return {
    id: product.id,
    displayName: product.displayName,
    capabilities,
    auth: {
      async beginLogin(input): Promise<BeginLoginResult> {
        const res = await fetcher(`${product.workOsBase}${CLINE_DEVICE_AUTHORIZATION_PATH}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            ...product.clientHeaders,
          },
          body: new URLSearchParams({ client_id: product.workOsClientId }).toString(),
        })
        if (!res.ok) {
          throw new UpstreamError({ kind: 'UPSTREAM_5XX', status: res.status, message: `Cline device authorization failed (HTTP ${res.status})` })
        }
        const auth = parseClineDeviceAuthorization(await res.json().catch(() => null))
        if (!auth) {
          throw new UpstreamError({ kind: 'TERMINAL', message: 'Cline device authorization response was not understood' })
        }
        const started = now()
        sessions.set(input.accountId, {
          deviceCode: auth.deviceCode,
          userCode: auth.userCode,
          authUrl: auth.verificationUriComplete ?? auth.verificationUri,
          intervalMs: auth.intervalMs || CLINE_DEVICE_AUTH_INTERVAL_MS,
          startedAt: started,
          expiresAt: started + (auth.expiresInMs || CLINE_DEVICE_AUTH_EXPIRES_MS),
          failures: 0,
        })
        return {
          loginUrl: auth.verificationUriComplete ?? auth.verificationUri,
          expiresIn: Math.floor((auth.expiresInMs || CLINE_DEVICE_AUTH_EXPIRES_MS) / 1000),
          pollInterval: Math.max(1, Math.floor((auth.intervalMs || CLINE_DEVICE_AUTH_INTERVAL_MS) / 1000)),
        }
      },
      async pollLogin(accountId): Promise<PollLoginResult> {
        const session = sessions.get(accountId)
        if (!session) return { done: false, error: 'login session not found or expired' }
        if (now() >= session.expiresAt) {
          sessions.delete(accountId)
          return { done: true, success: false, error: 'device code expired' }
        }
        try {
          const res = await fetcher(`${product.workOsBase}${CLINE_DEVICE_AUTHENTICATE_PATH}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
              ...product.clientHeaders,
            },
            body: new URLSearchParams({
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
              device_code: session.deviceCode,
              client_id: product.workOsClientId,
            }).toString(),
          })
          session.failures = 0
          const outcome = classifyClinePoll(res.status, await res.json().catch(() => null))
          if (outcome.status === 'pending') return { done: false }
          if (outcome.status === 'slow_down') {
            session.intervalMs += outcome.intervalMs
            return { done: false }
          }
          if (outcome.status === 'denied') {
            sessions.delete(accountId)
            return { done: true, success: false, error: outcome.error }
          }
          // Authorized: register the WorkOS token to get the Cline token.
          const registerRes = await fetcher(`${product.apiBase}${CLINE_REGISTER_PATH}`, {
            method: 'POST',
            headers: clineAnonymousHeaders(product),
            body: JSON.stringify({ accessToken: outcome.accessToken, refreshToken: outcome.refreshToken ?? '' }),
          })
          const token = parseClineTokenPayload(await registerRes.json().catch(() => null))
          if (!token) {
            sessions.delete(accountId)
            return { done: true, success: false, error: `Cline token registration failed (HTTP ${registerRes.status})` }
          }
          const credential = buildClineCredential(token, {})
          sessions.delete(accountId)
          return {
            done: true,
            success: true,
            credential,
            expiresAt: clineCredentialExpiresAtMs(credential) ?? null,
            displayName: credential.email ?? undefined,
          }
        } catch (err) {
          session.failures += 1
          if (session.failures >= MAX_POLL_FAILURES) {
            sessions.delete(accountId)
            return { done: true, success: false, error: err instanceof Error ? err.message : 'poll failed' }
          }
          return { done: false }
        }
      },
      async importCredential(_accountId, _provider, payload) {
        const record = (payload ?? {}) as Record<string, unknown>
        // Either a ready credential blob or a raw WorkOS token pair.
        if (typeof record.access_token === 'string' && record.access_token.length > 0) {
          const credential = record as unknown as ClineCredential
          return {
            expiresAt: clineCredentialExpiresAtMs(credential) ?? null,
            refreshable: isClineRefreshable(credential),
            credential,
          }
        }
        const token = parseClineTokenPayload(record)
        if (!token) {
          throw new UpstreamError({
            kind: 'NEEDS_MANUAL',
            message: 'importCredential expects a Cline credential blob or { accessToken, refreshToken }',
          })
        }
        const credential = buildClineCredential(token, {})
        return {
          expiresAt: clineCredentialExpiresAtMs(credential) ?? null,
          refreshable: isClineRefreshable(credential),
          credential,
        }
      },
    },
    ops: {
      async refreshAccount(ctx, account): Promise<RefreshResult> {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { refreshable: false, expiresAt: null, refreshed: false, error: 'no credential' }
        if (!isClineRefreshable(credential)) {
          return { refreshable: false, expiresAt: null, refreshed: false, error: 'not refreshable' }
        }
        const res = await fetcher(`${product.apiBase}${CLINE_REFRESH_PATH}`, {
          method: 'POST',
          headers: clineAnonymousHeaders(product),
          body: JSON.stringify(clineRefreshBody(credential)),
        })
        const token = parseClineTokenPayload(await res.json().catch(() => null))
        if (!token) {
          throw new UpstreamError({
            kind: res.status === 401 || res.status === 403 ? 'AUTH_INVALID' : 'TERMINAL',
            status: res.status,
            message: `Cline refresh failed (HTTP ${res.status})`,
          })
        }
        const updated = buildClineCredential(token, credential)
        return {
          refreshable: isClineRefreshable(updated),
          expiresAt: clineCredentialExpiresAtMs(updated) ?? null,
          refreshed: true,
          credential: updated,
        }
      },
      async getQuota(ctx, account): Promise<QuotaSnapshot> {
        const credential = await credentialOf(ctx, account)
        if (!credential) {
          return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now(), rawJson: null }
        }
        return toQuotaSnapshot(await fetchClineBalance(credential, product, fetcher))
      },
      // Cline has no daily check-in.
      async claimCredits() {
        return { kind: 'unsupported', message: 'Cline has no daily credit claim' }
      },
      async healthCheck(ctx, account) {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { ok: false, error: 'no credential' }
        const res = await fetcher(`${product.apiBase}${CLINE_MODELS_PATH}`, {
          headers: clineAuthHeadersLocal(credential),
        })
        if (res.status === 401 || res.status === 403) return { ok: false, error: `HTTP ${res.status}` }
        return { ok: res.ok }
      },
      mapError(err) {
        if (err instanceof UpstreamError) return err
        return new UpstreamError({ kind: 'TRANSPORT', message: err instanceof Error ? err.message : String(err) })
      },
    },
    chat: {
      async listModels(ctx, account): Promise<ModelEntry[]> {
        const credential = await credentialOf(ctx, account)
        const catalog = await discoverCatalog(credential)
        const source = catalog.length > 0 ? catalog : product.fallbackModels.map((m) => ({ ...m, isFree: m.id.startsWith('cline-free/') }))
        return source.map((m) => ({
          modelId: m.id,
          provider: product.id,
          upstreamModel: m.id,
          name: m.name,
          capabilities: { vision: true, toolCall: true, streaming: true },
          enabled: true,
          priority: 0,
          metadataJson: JSON.stringify({ free: m.isFree }),
        }))
      },
      async chat(ctx, req, account) {
        return aggregate(ctx, account, req)
      },
      stream(ctx, req, account, _tools: Tool[]) {
        return streamChat(ctx, account, req)
      },
    },
  }
}
