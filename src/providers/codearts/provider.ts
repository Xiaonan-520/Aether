/**
 * CodeArts (华为云码道) provider adapter.
 *
 * Chat is OpenAI-compatible SSE signed with SDK-HMAC-SHA256 (temporary AK/SK).
 * CodeArts has **no refresh endpoint** — the credential is a temporary AK/SK, so
 * an expired credential requires re-login (`supportsRefreshToken: false`).
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
  CODEARTS,
  CODEARTS_CHAT_PATH,
  CODEARTS_SNAP_MODEL_BUILTIN_PATH,
  type CodeArtsProduct,
} from './product.js'
import {
  isCodeArtsBenefitModel,
  isCodeArtsExpired,
  parseCodeArtsCredential,
  parseCodeArtsModels,
  type CodeArtsCredential,
  type Fetcher,
} from './protocol.js'
import { signHuaweiRequest } from './sign.js'
import { claimCodeArtsCredits } from './credits.js'

const LOGIN_TTL_MS = 10 * 60 * 1000

export interface CodeArtsProviderOptions {
  product?: CodeArtsProduct
  fetcher?: Fetcher
}

interface LoginSession {
  authUrl: string
  startedAt: number
}

export function createCodeArtsProvider(options: CodeArtsProviderOptions = {}): Provider {
  const product = options.product ?? CODEARTS
  const fetcher = options.fetcher ?? fetch
  const sessions = new Map<string, LoginSession>()

  const capabilities: ProviderCapabilities = {
    supportsOAuth: true,
    // temporary AK/SK only — no refresh endpoint
    supportsRefreshToken: false,
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

  async function credentialOf(ctx: ProviderCtx, account: Account): Promise<CodeArtsCredential | undefined> {
    const handle = await ctx.resolveCredential(account)
    return handle?.credential as CodeArtsCredential | undefined
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

  /** Signed GET against the snap host (shared by models/health). */
  async function signedGet(
    credential: CodeArtsCredential,
    path: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const url = `${product.snapBase}${path}`
    const signed = signHuaweiRequest(
      credential.access_key_id,
      credential.secret_access_key,
      credential.security_token,
      'GET',
      url,
      new Uint8Array(),
      { 'agent-type': product.agentTypeHeader },
    )
    const res = await fetcher(url, { method: 'GET', headers: { ...signed.headers, 'user-agent': product.userAgent } })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { ok: res.ok, status: res.status, body }
  }

  /** Sign and send the chat request; a benefit model needs `maas_type`. */
  async function sendChat(credential: CodeArtsCredential, body: Record<string, unknown>): Promise<Response> {
    const url = `${product.chatBase}${CODEARTS_CHAT_PATH}`
    const payload = new TextEncoder().encode(JSON.stringify(body))
    const extra: Record<string, string> = { 'agent-type': product.agentTypeHeader }
    if (isCodeArtsBenefitModel(String(body.model ?? ''))) extra.maas_type = 'benefit'
    const signed = signHuaweiRequest(
      credential.access_key_id,
      credential.secret_access_key,
      credential.security_token,
      'POST',
      url,
      payload,
      extra,
    )
    return fetcher(url, {
      method: 'POST',
      headers: { ...signed.headers, 'user-agent': product.userAgent, accept: 'text/event-stream' },
      body: payload,
    })
  }

  async function* streamChat(ctx: ProviderCtx, account: Account, req: ChatRequest): AsyncIterable<ChatChunk> {
    const credential = await credentialOf(ctx, account)
    if (!credential?.access_key_id) {
      throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'account has no CodeArts credential' })
    }
    if (isCodeArtsExpired(credential)) {
      throw new UpstreamError({ kind: 'TOKEN_EXPIRED', message: 'CodeArts credential expired; re-login required' })
    }
    const body: Record<string, unknown> = {
      model: bareModel(req.model),
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls
          ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) }
          : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      stream: true,
    }
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    }
    const res = await sendChat(credential, body)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw classify(res.status, `CodeArts chat failed (HTTP ${res.status}) ${text.slice(0, 200)}`)
    }
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

  return {
    id: product.id,
    displayName: product.displayName,
    capabilities,
    auth: {
      async beginLogin(input): Promise<BeginLoginResult> {
        const authUrl = `${product.consoleBase}/portal/login`
        sessions.set(input.accountId, { authUrl, startedAt: Date.now() })
        return { loginUrl: authUrl, expiresIn: Math.floor(LOGIN_TTL_MS / 1000), pollInterval: 3 }
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
        // Either a ready AK/SK blob, or a ticket response to parse.
        const credential =
          typeof record.access_key_id === 'string' && record.access_key_id.length > 0
            ? (record as unknown as CodeArtsCredential)
            : parseCodeArtsCredential(record)
        if (!credential) {
          throw new UpstreamError({
            kind: 'NEEDS_MANUAL',
            message: 'importCredential expects a CodeArts AK/SK credential or a credential-ticket response',
          })
        }
        sessions.delete(accountId)
        const expiresAt = credential.expires_at ? Number(credential.expires_at) : null
        return { expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, refreshable: false }
      },
    },
    ops: {
      async refreshAccount(_ctx, account): Promise<RefreshResult> {
        // CodeArts has no refresh endpoint; the AK/SK are temporary.
        return {
          refreshable: false,
          expiresAt: null,
          refreshed: false,
          error: 'CodeArts credentials are temporary AK/SK; re-login is required when they expire',
        }
      },
      async getQuota(ctx, account): Promise<QuotaSnapshot> {
        const credential = await credentialOf(ctx, account)
        const now = Date.now()
        if (!credential) {
          return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now, rawJson: null }
        }
        // package info exposes the account's entitlement
        const res = await signedGet(credential, '/snap-manager/v1/statistics/plugin')
        if (!res.ok || res.body === null) {
          return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now, rawJson: null }
        }
        const record = res.body as Record<string, unknown>
        const data = typeof record.data === 'object' && record.data !== null ? (record.data as Record<string, unknown>) : record
        const pick = (key: string): number | null => (typeof data[key] === 'number' ? (data[key] as number) : null)
        const remaining = pick('remaining') ?? pick('balance') ?? pick('credits')
        return {
          known: remaining !== null,
          remaining,
          total: pick('total') ?? pick('totalCredits'),
          resetAt: null,
          lastUpdatedAt: now,
          rawJson: JSON.stringify(data),
        }
      },
      async claimCredits(ctx, account) {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { kind: 'needs_auth', message: 'no credential' }
        return claimCodeArtsCredits({ product, credential, fetcher })
      },
      async healthCheck(ctx, account) {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { ok: false, error: 'no credential' }
        const res = await signedGet(credential, CODEARTS_SNAP_MODEL_BUILTIN_PATH)
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
        let remote: ReturnType<typeof parseCodeArtsModels> = []
        if (credential) {
          const res = await signedGet(credential, CODEARTS_SNAP_MODEL_BUILTIN_PATH)
          if (res.ok) remote = parseCodeArtsModels(res.body)
        }
        const source = remote.length > 0 ? remote : product.fallbackModels.map((m) => ({ ...m }))
        return source.map((m) => ({
          modelId: m.id,
          provider: product.id,
          upstreamModel: m.id,
          name: m.name,
          capabilities: { vision: false, toolCall: true, streaming: true },
          enabled: true,
          priority: 0,
          metadataJson: isCodeArtsBenefitModel(m.id) ? JSON.stringify({ benefit: true }) : null,
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
