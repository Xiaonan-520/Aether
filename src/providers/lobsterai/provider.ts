/**
 * LobsterAI (有道龙虾) provider adapter.
 *
 * LobsterAI is a separate protocol family from the Buddy products: local-host
 * callback login + `authCode` exchange, its own `X-LobsterAI-Client-*` headers,
 * and an OpenAI-compatible SSE-only chat endpoint.
 *
 * Login is a two-step flow because the portal requires a
 * `http://127.0.0.1:<port>/auth/callback` redirect_uri. The gateway exposes the
 * authorization URL and the operator pastes the resulting `code` back through
 * the generic captcha/import seam; no callback server is started inside the
 * container (it would be unreachable anyway).
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
import { decodeSseStream } from '../../protocol/openai/sse.js'
import { LOBSTERAI, type LobsteraiProduct } from './product.js'
import {
  LOBSTERAI_CHAT_PATH,
  LOBSTERAI_EXCHANGE_PATH,
  LOBSTERAI_MODELS_PATH,
  LOBSTERAI_REFRESH_PATH,
  buildLobsteraiCredential,
  buildLobsteraiLoginUrl,
  createLobsteraiLoginSession,
  isLobsteraiRefreshable,
  lobsteraiAnonymousHeaders,
  lobsteraiCredentialExpiresAtMs,
  lobsteraiChatHeaders,
  lobsteraiModelsHeaders,
  lobsteraiRefreshBody,
  parseLobsteraiEnvelope,
  parseLobsteraiModels,
  parseLobsteraiTokenPayload,
  LobsteraiClientVersionResolver,
  type Fetcher,
  type LobsteraiCredential,
} from './protocol.js'
import { claimLobsteraiCredits, fetchLobsteraiBalance, probeLobsteraiAccount } from './credits.js'

interface LoginSession {
  state: string
  session: { uuid: string; firstKeyfrom: string }
  port: number
  authUrl: string
  startedAt: number
}

/** The login callback must target a loopback address; the port is only used to
 * build the redirect_uri the portal validates, not to listen locally. */
const CALLBACK_PORT = 17650
const LOGIN_TTL_MS = 10 * 60 * 1000

/** Preserve the remote context window on the model entry (JSON metadata). */
function contextWindowMetadata(contextWindow: number | undefined): string | null {
  return contextWindow === undefined ? null : JSON.stringify({ contextWindow })
}

export interface LobsteraiProviderOptions {
  product?: LobsteraiProduct
  fetcher?: Fetcher
}

export function createLobsteraiProvider(options: LobsteraiProviderOptions = {}): Provider {
  const product = options.product ?? LOBSTERAI
  const fetcher = options.fetcher ?? fetch
  const versions = new LobsteraiClientVersionResolver(product, fetcher)
  const sessions = new Map<string, LoginSession>()

  const capabilities: ProviderCapabilities = {
    supportsOAuth: true,
    supportsRefreshToken: true,
    supportsQuota: true,
    supportsCredits: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsToolCall: true,
    supportsMultipleAccounts: true,
    needsCaptcha: false,
    // localhost callback + authCode exchange
    loginMode: 'external-link',
    protocol: 'openai-chat',
  }

  async function credentialOf(ctx: ProviderCtx, account: Account): Promise<LobsteraiCredential | undefined> {
    const handle = await ctx.resolveCredential(account)
    return handle?.credential as LobsteraiCredential | undefined
  }

  function bareModel(model: string): string {
    const sep = model.indexOf('::')
    return sep > 0 ? model.slice(sep + 2) : model
  }

  async function clientVersion(): Promise<string> {
    return (await versions.resolve()).version
  }

  /** Build a credential from an exchange/refresh payload, keeping install ids. */
  function mergeCredential(payload: ReturnType<typeof parseLobsteraiTokenPayload>, base: Partial<LobsteraiCredential>): LobsteraiCredential {
    return buildLobsteraiCredential(payload!, base)
  }

  function classify(status: number, message: string): UpstreamError {
    if (status === 401 || status === 403) return new UpstreamError({ kind: 'AUTH_INVALID', status, message })
    if (status === 429) return new UpstreamError({ kind: 'RATE_LIMIT', status, message })
    if (status >= 500) return new UpstreamError({ kind: 'UPSTREAM_5XX', status, message })
    return new UpstreamError({ kind: 'TERMINAL', status, message })
  }

  async function openaiChatBody(req: ChatRequest, model: string, stream: boolean): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls ? { tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })) } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      stream,
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

  async function upstreamChat(
    ctx: ProviderCtx,
    account: Account,
    req: ChatRequest,
    includeTools: boolean,
  ): Promise<Response> {
    const credential = await credentialOf(ctx, account)
    if (!credential?.access_token) {
      throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'account has no LobsterAI access token' })
    }
    const version = await clientVersion()
    const res = await fetcher(`${product.apiBase}${LOBSTERAI_CHAT_PATH}`, {
      method: 'POST',
      headers: lobsteraiChatHeaders(credential, product, version),
      body: JSON.stringify(await openaiChatBody(req, bareModel(req.model), true)),
    })
    if (!res.ok) {
      throw classify(res.status, `LobsterAI chat failed (HTTP ${res.status})`)
    }
    void includeTools
    return res
  }

  async function* streamChat(
    ctx: ProviderCtx,
    account: Account,
    req: ChatRequest,
    tools?: Tool[],
  ): AsyncIterable<ChatChunk> {
    const res = await upstreamChat(ctx, account, req, tools !== undefined)
    // decodeSseStream maps OpenAI SSE frames onto canonical ChatChunks.
    for await (const chunk of decodeSseStream(res.body as unknown as AsyncIterable<Uint8Array>)) {
      if (chunk.text === '' && chunk.reasoning === undefined && chunk.finishReason == null && !chunk.usage) continue
      yield chunk
    }
  }

  async function aggregate(
    ctx: ProviderCtx,
    account: Account,
    req: ChatRequest,
    tools?: Tool[],
  ): Promise<ChatResult> {
    let content = ''
    let reasoning = ''
    let finishReason: ChatResult['finishReason'] = 'stop'
    let usage: ChatResult['usage']
    for await (const chunk of streamChat(ctx, account, req, tools)) {
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
        const state = `${input.accountId}-${Date.now()}`
        const session = createLobsteraiLoginSession()
        const authUrl = buildLobsteraiLoginUrl(CALLBACK_PORT, state, product)
        sessions.set(input.accountId, { state, session, port: CALLBACK_PORT, authUrl, startedAt: Date.now() })
        // The portal redirects to loopback, so the operator opens the URL and
        // pastes the `code` from the callback URL back into the gateway.
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
      async importCredential(accountId, _provider, payload) {
        const record = (payload ?? {}) as Record<string, unknown>
        const code = typeof record.code === 'string' ? record.code : undefined
        // Path 1: an auth code from the callback URL → exchange for tokens.
        if (code) {
          const session = sessions.get(accountId)
          const version = await clientVersion()
          const res = await fetcher(`${product.apiBase}${LOBSTERAI_EXCHANGE_PATH}`, {
            method: 'POST',
            headers: lobsteraiAnonymousHeaders(product),
            body: JSON.stringify({
              authCode: code,
              firstKeyfrom: session?.session.firstKeyfrom ?? String(Date.now()),
              latestKeyfrom: String(Date.now()),
              uuid: session?.session.uuid ?? crypto.randomUUID(),
              version,
            }),
          })
          const envelope = parseLobsteraiEnvelope(await res.json().catch(() => null))
          const tokenPayload = envelope.ok ? parseLobsteraiTokenPayload(envelope.data) : undefined
          if (!tokenPayload) {
            throw new UpstreamError({
              kind: 'AUTH_INVALID',
              status: res.status,
              message: `LobsterAI exchange failed: ${envelope.message || `HTTP ${res.status}`}`,
            })
          }
          const credential = mergeCredential(tokenPayload, {
            uuid: session?.session.uuid,
            first_keyfrom: session?.session.firstKeyfrom,
            latest_keyfrom: String(Date.now()),
          })
          sessions.delete(accountId)
          return {
            expiresAt: lobsteraiCredentialExpiresAtMs(credential) ?? null,
            refreshable: isLobsteraiRefreshable(credential),
            credential,
            ...(credential.nickname ? { displayName: credential.nickname } : {}),
          }
        }
        // Path 2: a ready credential blob (disk-credential / manual import).
        if (typeof record.access_token === 'string' && record.access_token.length > 0) {
          const credential = record as unknown as LobsteraiCredential
          return {
            expiresAt: lobsteraiCredentialExpiresAtMs(credential) ?? null,
            refreshable: isLobsteraiRefreshable(credential),
            credential,
          }
        }
        throw new UpstreamError({
          kind: 'NEEDS_MANUAL',
          message: 'importCredential expects a "code" from the callback URL or a LobsterAI credential blob',
        })
      },
    },
    ops: {
      async refreshAccount(ctx, account): Promise<RefreshResult> {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { refreshable: false, expiresAt: null, refreshed: false, error: 'no credential' }
        if (!isLobsteraiRefreshable(credential)) {
          return { refreshable: false, expiresAt: null, refreshed: false, error: 'not refreshable' }
        }
        const version = await clientVersion()
        const res = await fetcher(`${product.apiBase}${LOBSTERAI_REFRESH_PATH}`, {
          method: 'POST',
          headers: lobsteraiAnonymousHeaders(product),
          body: JSON.stringify(lobsteraiRefreshBody(credential, version)),
        })
        const envelope = parseLobsteraiEnvelope(await res.json().catch(() => null))
        const tokenPayload = envelope.ok ? parseLobsteraiTokenPayload(envelope.data) : undefined
        if (!tokenPayload) {
          throw new UpstreamError({
            kind: 'AUTH_INVALID',
            status: res.status,
            message: `LobsterAI refresh failed: ${envelope.message || `HTTP ${res.status}`}`,
          })
        }
        const updated = mergeCredential(tokenPayload, credential)
        return {
          refreshable: isLobsteraiRefreshable(updated),
          expiresAt: lobsteraiCredentialExpiresAtMs(updated) ?? null,
          refreshed: true,
          // LobsterAI rotates refresh tokens, so the new credential must be
          // persisted by the caller or the account becomes unusable.
          credential: updated,
        }
      },
      async getQuota(_ctx, account): Promise<QuotaSnapshot> {
        const credential = await credentialOf(_ctx, account)
        if (!credential) {
          return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: Date.now(), rawJson: null }
        }
        const balance = await fetchLobsteraiBalance({
          product,
          credential,
          clientVersion: await clientVersion(),
          fetcher,
        })
        return {
          known: balance.known,
          remaining: balance.remaining,
          total: balance.total,
          resetAt: null,
          lastUpdatedAt: balance.lastUpdatedAt,
          rawJson: balance.rawJson,
        }
      },
      async claimCredits(ctx, account) {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { kind: 'needs_auth', message: 'no credential' }
        return claimLobsteraiCredits({
          product,
          credential,
          clientVersion: await clientVersion(),
          fetcher,
        })
      },
      async healthCheck(ctx, account) {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { ok: false, error: 'no credential' }
        return probeLobsteraiAccount({
          product,
          credential,
          clientVersion: await clientVersion(),
          fetcher,
        })
      },
      mapError(err) {
        if (err instanceof UpstreamError) return err
        return new UpstreamError({
          kind: 'TRANSPORT',
          message: err instanceof Error ? err.message : String(err),
        })
      },
    },
    chat: {
      async listModels(ctx, account): Promise<ModelEntry[]> {
        const credential = await credentialOf(ctx, account)
        const version = await clientVersion()
        let remote: Array<{ id: string; name: string; contextWindow?: number }> = []
        if (credential?.access_token) {
          const res = await fetcher(`${product.apiBase}${LOBSTERAI_MODELS_PATH}`, {
            headers: lobsteraiModelsHeaders(credential, product, version),
          })
          if (res.ok) remote = parseLobsteraiModels(await res.json().catch(() => null))
        }
        const source = remote.length > 0
          ? remote
          : product.fallbackModels.map((m) => ({ ...m }))
        return source.map((m) => ({
          modelId: modelIdOf(product.id, m.id),
          provider: product.id,
          upstreamModel: m.id,
          name: m.name,
          capabilities: { vision: true, toolCall: true, streaming: true },
          enabled: true,
          priority: 0,
          metadataJson: contextWindowMetadata(m.contextWindow),
        }))
      },
      async chat(ctx, req, account, tools) {
        return aggregate(ctx, account, req, tools)
      },
      stream(ctx, req, account, tools) {
        return streamChat(ctx, account, req, tools)
      },
    },
  }
}
