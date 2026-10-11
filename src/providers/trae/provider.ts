/**
 * TRAE provider adapter, shared by TRAE CN and TRAE INTL.
 *
 * Differences between the two products are entirely config (hosts, site), the
 * same approach used for the Buddy family. TRAE specifics handled here:
 * - the SOLO request-body transform (OpenAI → SOLO) and SOLO SSE → ChatChunk,
 * - per-account device identity (`machine_id` / `device_id`) that must be
 *   persisted and must never be shared between accounts,
 * - refresh-token rotation via ExchangeToken.
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
import { modelIdOf } from '../../core/naming.js'
import { TRAE, type TraeProduct } from './product.js'
import {
  TRAE_BATCH_MODELS_PATH,
  TRAE_CHAT_PATH,
  TRAE_EXCHANGE_PATH,
  TRAE_MAX_OUTPUT_TOKENS,
  TRAE_USER_INFO_PATH,
} from './product.js'
import {
  newTraeDeviceIdentity,
  parseTraeBatchModelList,
  parseTraeSoloEvents,
  transformToSOLOBody,
  traeSOLOHeaders,
  type Fetcher,
  type TraeCredential,
} from './protocol.js'
import { claimTraeCredits, fetchTraeQuota } from './credits.js'

const LOGIN_TTL_MS = 10 * 60 * 1000

export interface TraeProviderOptions {
  product?: TraeProduct
  fetcher?: Fetcher
}

interface LoginSession {
  authUrl: string
  startedAt: number
}

export function createTraeProvider(options: TraeProviderOptions = {}): Provider {
  const product = options.product ?? TRAE
  const fetcher = options.fetcher ?? fetch
  const sessions = new Map<string, LoginSession>()

  const capabilities: ProviderCapabilities = {
    supportsOAuth: true,
    supportsRefreshToken: true,
    supportsQuota: true,
    supportsCredits: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsToolCall: true,
    supportsMultipleAccounts: true,
    needsCaptcha: false,
    loginMode: 'external-link',
    protocol: 'openai-chat',
  }

  async function credentialOf(ctx: ProviderCtx, account: Account): Promise<TraeCredential | undefined> {
    const handle = await ctx.resolveCredential(account)
    return handle?.credential as TraeCredential | undefined
  }

  function bareModel(model: string): string {
    const sep = model.indexOf('::')
    return sep > 0 ? model.slice(sep + 2) : model
  }

  function classify(status: number, message: string): UpstreamError {
    if (status === 401 || status === 403) return new UpstreamError({ kind: 'AUTH_INVALID', status, message })
    if (status === 429) return new UpstreamError({ kind: 'RATE_LIMIT', status, message })
    if (status >= 500) return new UpstreamError({ kind: 'UPSTREAM_5XX', status, message })
    return new UpstreamError({ kind: 'TERMINAL', status, message })
  }

  /** Build the credential from an ExchangeToken / register payload. */
  function buildCredential(data: Record<string, unknown>, base: Partial<TraeCredential>): TraeCredential {
    const access = typeof data.access_token === 'string' ? data.access_token : (base.access_token ?? '')
    const refresh = typeof data.refresh_token === 'string' ? data.refresh_token : (base.refresh_token ?? '')
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : undefined
    const user = typeof data.user === 'object' && data.user !== null ? (data.user as Record<string, unknown>) : {}
    const uid =
      (typeof user.id === 'string' ? user.id : undefined) ??
      (typeof user.user_id === 'string' ? user.user_id : undefined) ??
      (typeof data.uid === 'string' ? data.uid : undefined) ??
      base.uid
    return {
      access_token: access,
      refresh_token: refresh,
      ...(expiresIn ? { expires_at: String(Date.now() + expiresIn * 1000) } : (base.expires_at ? { expires_at: base.expires_at } : {})),
      ...(uid ? { uid } : {}),
      ...(typeof user.nickname === 'string' ? { nickname: user.nickname } : base.nickname ? { nickname: base.nickname } : {}),
      machine_id: base.machine_id ?? '',
      device_id: base.device_id ?? '',
    }
  }

  async function* streamChat(ctx: ProviderCtx, account: Account, req: ChatRequest): AsyncIterable<ChatChunk> {
    const credential = await credentialOf(ctx, account)
    if (!credential?.access_token) {
      throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'account has no TRAE access token' })
    }
    const body: Record<string, unknown> = {
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      model: bareModel(req.model),
    }
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    else body.max_tokens = TRAE_MAX_OUTPUT_TOKENS
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    }
    const soloBody = transformToSOLOBody(body, product.function)
    const res = await fetcher(`${product.agentHost}${TRAE_CHAT_PATH}`, {
      method: 'POST',
      headers: traeSOLOHeaders(credential, product, true),
      body: JSON.stringify(soloBody),
    })
    if (!res.ok) throw classify(res.status, `TRAE chat failed (HTTP ${res.status})`)
    for await (const event of parseTraeSoloEvents(res.body as unknown as AsyncIterable<Uint8Array>)) {
      if (event.event === 'output') {
        const text = typeof event.data.response === 'string' ? event.data.response : ''
        const reasoning = typeof event.data.reasoning_content === 'string' ? event.data.reasoning_content : undefined
        const chunk: ChatChunk = { text }
        if (reasoning !== undefined && reasoning !== '') chunk.reasoning = reasoning
        if (text !== '' || chunk.reasoning !== undefined) yield chunk
      } else if (event.event === 'token_usage') {
        yield {
          text: '',
          usage: {
            promptTokens: typeof event.data.prompt_tokens === 'number' ? event.data.prompt_tokens : undefined,
            completionTokens: typeof event.data.completion_tokens === 'number' ? event.data.completion_tokens : undefined,
          },
        }
      } else if (event.event === 'done') {
        const reason = typeof event.data.finish_reason === 'string' ? event.data.finish_reason : 'stop'
        yield { text: '', finishReason: reason as ChatChunk['finishReason'] }
      } else if (event.event === 'error') {
        const message = typeof event.data.message === 'string' ? event.data.message : 'TRAE upstream error'
        throw new UpstreamError({ kind: 'TERMINAL', message })
      }
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

  return {
    id: product.id,
    displayName: product.displayName,
    capabilities,
    auth: {
      async beginLogin(input): Promise<BeginLoginResult> {
        // TRAE forces a loopback callback; the operator completes login in a
        // browser and pastes the callback URL back through importCredential.
        const state = `${input.accountId}-${Date.now()}`
        const authUrl = `${product.consoleHost}/authorization?client_id=${product.clientId}&state=${encodeURIComponent(state)}`
        sessions.set(input.accountId, { authUrl, startedAt: Date.now() })
        return { loginUrl: authUrl, expiresIn: Math.floor(LOGIN_TTL_MS / 1000), pollInterval: 2 }
      },
      async pollLogin(accountId): Promise<PollLoginResult> {
        const session = sessions.get(accountId)
        if (!session) return { done: false, error: 'login session not found or expired' }
        if (Date.now() - session.startedAt > LOGIN_TTL_MS) {
          sessions.delete(accountId)
          return { done: true, success: false, error: 'login timed out' }
        }
        return { done: false }
      },
      /**
       * Accepts either an exchanged credential blob or a refresh token from the
       * callback URL. A fresh device identity is generated once here and then
       * persisted; it is never regenerated on refresh.
       */
      async importCredential(accountId, _provider, payload) {
        const record = (payload ?? {}) as Record<string, unknown>
        if (typeof record.access_token === 'string' && record.access_token.length > 0) {
          const credential = record as unknown as TraeCredential
          return {
            expiresAt: credential.expires_at ? Number(credential.expires_at) : null,
            refreshable: typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0,
            credential,
          }
        }
        const refreshToken = typeof record.refresh_token === 'string' ? record.refresh_token : undefined
        if (!refreshToken) {
          throw new UpstreamError({
            kind: 'NEEDS_MANUAL',
            message: 'importCredential expects a TRAE credential blob or { refresh_token }',
          })
        }
        const device = newTraeDeviceIdentity()
        const exchange = await exchangeToken(product, { refresh_token: refreshToken, machine_id: device.machine_id, device_id: device.device_id }, fetcher)
        const credential = buildCredential(exchange, { ...device, refresh_token: refreshToken, expires_at: String(Date.now() + 3_600_000) })
        sessions.delete(accountId)
        return {
          expiresAt: credential.expires_at ? Number(credential.expires_at) : null,
          refreshable: credential.refresh_token.length > 0,
          credential,
        }
      },
    },
    ops: {
      async refreshAccount(ctx, account): Promise<RefreshResult> {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { refreshable: false, expiresAt: null, refreshed: false, error: 'no credential' }
        if (!credential.refresh_token) {
          return { refreshable: false, expiresAt: null, refreshed: false, error: 'not refreshable' }
        }
        // ExchangeToken rotates the refresh token; identity fields stay untouched.
        const data = await exchangeToken(product, credential, fetcher)
        const updated = buildCredential(data, credential)
        return {
          refreshable: updated.refresh_token.length > 0,
          expiresAt: updated.expires_at ? Number(updated.expires_at) : null,
          refreshed: true,
          credential: updated,
        }
      },
      async getQuota(ctx, account): Promise<QuotaSnapshot> {
        const credential = await credentialOf(ctx, account)
        if (!credential?.uid) {
          return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: Date.now(), rawJson: null }
        }
        return fetchTraeQuota({ product, credential, uid: credential.uid, fetcher })
      },
      async claimCredits(ctx, account) {
        const credential = await credentialOf(ctx, account)
        if (!credential?.uid) return { kind: 'needs_auth', message: 'credential has no uid' }
        return claimTraeCredits({ product, credential, uid: credential.uid, fetcher })
      },
      async healthCheck(ctx, account) {
        const credential = await credentialOf(ctx, account)
        if (!credential?.access_token) return { ok: false, error: 'no credential' }
        const res = await fetcher(`${product.oauthHost}${TRAE_USER_INFO_PATH}`, {
          method: 'POST',
          headers: traeSOLOHeaders(credential, product, false),
          body: '{}',
        })
        if (res.status === 401 || res.status === 403) return { ok: false, error: `HTTP ${res.status}` }
        return { ok: res.ok || res.status === 404 }
      },
      mapError(err) {
        if (err instanceof UpstreamError) return err
        return new UpstreamError({ kind: 'TRANSPORT', message: err instanceof Error ? err.message : String(err) })
      },
    },
    chat: {
      async listModels(ctx, account): Promise<ModelEntry[]> {
        const credential = await credentialOf(ctx, account)
        let remote: ReturnType<typeof parseTraeBatchModelList> = []
        if (credential?.access_token) {
          const res = await fetcher(`${product.agentHost}${TRAE_BATCH_MODELS_PATH}`, {
            method: 'POST',
            headers: traeSOLOHeaders(credential, product, false),
            body: '{}',
          })
          if (res.ok) remote = parseTraeBatchModelList(await res.json().catch(() => null), product.channels)
        }
        const source = remote.length > 0
          ? remote.map((m) => ({ id: m.id, name: m.name }))
          : product.fallbackModels.map((m) => ({ ...m }))
        return source.map((m) => ({
          modelId: modelIdOf(product.id, m.id),
          provider: product.id,
          upstreamModel: m.id,
          name: m.name,
          capabilities: { vision: false, toolCall: true, streaming: true },
          enabled: true,
          priority: 0,
          metadataJson: null,
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

/** ExchangeToken — rotates the refresh token and returns a new access token. */
async function exchangeToken(
  product: TraeProduct,
  credential: Partial<TraeCredential>,
  fetcher: Fetcher,
): Promise<Record<string, unknown>> {
  const res = await fetcher(`${product.oauthHost}${TRAE_EXCHANGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': product.userAgent },
    body: JSON.stringify({
      refresh_token: credential.refresh_token ?? '',
      client_id: product.clientId,
      ...(credential.machine_id ? { machine_id: credential.machine_id } : {}),
    }),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  const data = typeof body.data === 'object' && body.data !== null ? (body.data as Record<string, unknown>) : body
  if (!res.ok || typeof data.access_token !== 'string') {
    throw new UpstreamError({
      kind: res.status === 401 || res.status === 403 ? 'AUTH_INVALID' : 'TERMINAL',
      status: res.status,
      message: `TRAE ExchangeToken failed (HTTP ${res.status})`,
    })
  }
  return data
}
