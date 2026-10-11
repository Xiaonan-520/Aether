/**
 * Loomy (讯飞办公助手) provider adapter.
 *
 * Login is SMS verification-code based (`loginMode: 'sms'`): the gateway sends
 * the code and the operator submits it. There is **no refresh endpoint** — the
 * session is declared valid for 14 days at login, so an expired session means
 * re-login (`supportsRefreshToken: false`, honest rather than faking refresh).
 *
 * Chat is standard OpenAI-compatible SSE; the account endpoints use HMAC-SHA1.
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
import {
  LOOMY,
  LOOMY_CHECK_CODE_PATH,
  LOOMY_CHAT_PATH,
  LOOMY_MODELS_PATH,
  LOOMY_SEND_CODE_PATH,
  type LoomyProduct,
} from './product.js'
import {
  isLoomyRefreshable,
  loomyBusinessHeaders,
  loomyChatHeaders,
  loomyCheckCodeBody,
  loomySendCodeBody,
  parseLoomyEnvelope,
  parseLoomyModels,
  type Fetcher,
  type LoomyCredential,
} from './protocol.js'
import { signLoomyRequest } from './sign.js'
import { claimLoomyDailyQuota, fetchLoomyQuota } from './credits.js'

export interface LoomyProviderOptions {
  product?: LoomyProduct
  fetcher?: Fetcher
  now?: () => number
}

interface LoginSession {
  phone: string
  mode: 'send-code' | 'await-code'
  /** msgid returned by sendMsgCode, required by checkCode */
  msgid?: string
  /** pending credential produced once the code is accepted */
  credential?: LoomyCredential
  startedAt: number
}

const LOGIN_TTL_MS = 10 * 60 * 1000
/** session validity requested at login (14 days) */
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000

export function createLoomyProvider(options: LoomyProviderOptions = {}): Provider {
  const product = options.product ?? LOOMY
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now
  const sessions = new Map<string, LoginSession>()

  const capabilities: ProviderCapabilities = {
    supportsOAuth: true,
    // no refresh endpoint: sessions expire after 14 days and need re-login
    supportsRefreshToken: false,
    supportsQuota: true,
    supportsCredits: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsToolCall: false,
    supportsMultipleAccounts: true,
    needsCaptcha: false,
    loginMode: 'sms',
    protocol: 'openai-chat',
  }

  async function credentialOf(ctx: ProviderCtx, account: Account): Promise<LoomyCredential | undefined> {
    const handle = await ctx.resolveCredential(account)
    return handle?.credential as LoomyCredential | undefined
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

  /** Signed POST to the iFlytek account host. */
  async function postAccount(path: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${product.accountBase}${path}`
    const payload = JSON.stringify(body)
    const signed = signLoomyRequest({
      accessKeyId: product.accessKeyId,
      accessKeySecret: product.accessKeySecret,
      method: 'POST',
      path,
      body: payload,
      contentType: 'application/json',
    })
    const res = await fetcher(url, {
      method: 'POST',
      headers: { ...signed, 'Content-Type': 'application/json' },
      body: payload,
    })
    return res.json().catch(() => null)
  }

  async function* streamChat(ctx: ProviderCtx, account: Account, req: ChatRequest): AsyncIterable<ChatChunk> {
    const credential = await credentialOf(ctx, account)
    if (!credential?.access_token) {
      throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'account has no Loomy session' })
    }
    const body: Record<string, unknown> = {
      model: bareModel(req.model),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    }
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    const res = await fetcher(`${product.apiBase}${LOOMY_CHAT_PATH}`, {
      method: 'POST',
      headers: loomyChatHeaders(credential.access_token),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw classify(res.status, `Loomy chat failed (HTTP ${res.status})`)
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
      /**
       * SMS login step 1: the caller supplies the phone number, the gateway
       * sends the code and returns with `needsManual` so the operator can enter
       * it (no captcha bypass is involved — this is the normal flow).
       */
      async beginLogin(input): Promise<BeginLoginResult> {
        const phone = typeof input.phone === 'string' ? input.phone.trim() : ''
        if (phone === '') {
          return { expiresIn: 300, pollInterval: 2, needsManual: true }
        }
        const body = loomySendCodeBody(phone)
        const envelope = parseLoomyEnvelope(await postAccount(LOOMY_SEND_CODE_PATH, body))
        if (!envelope.ok) {
          throw new UpstreamError({ kind: 'NEEDS_MANUAL', message: `sendMsgCode failed (code ${envelope.code})` })
        }
        const msgid = typeof envelope.data.msgid === 'string' ? envelope.data.msgid : undefined
        sessions.set(input.accountId, { phone, mode: 'await-code', ...(msgid ? { msgid } : {}), startedAt: now() })
        return { expiresIn: 300, pollInterval: 2, needsManual: true }
      },
      /**
       * Poll step: the operator submits the code via `importCredential`.
       * Returns pending until that happens, then hands over the credential.
       */
      async pollLogin(accountId): Promise<PollLoginResult> {
        const session = sessions.get(accountId)
        if (!session) return { done: false, error: 'login session not found or expired' }
        if (now() - session.startedAt > LOGIN_TTL_MS) {
          sessions.delete(accountId)
          return { done: true, success: false, error: 'login timed out' }
        }
        if (session.credential) {
          const credential = session.credential
          sessions.delete(accountId)
          return {
            done: true,
            success: true,
            credential,
            expiresAt: credential.expires_at ? Number(credential.expires_at) : null,
            ...(credential.nickname ? { displayName: credential.nickname } : {}),
          }
        }
        return { done: false }
      },
      /** SMS login step 2: submit the phone code, or import a ready session. */
      async importCredential(accountId, _provider, payload) {
        const record = (payload ?? {}) as Record<string, unknown>
        // ready session blob
        if (typeof record.access_token === 'string' && record.access_token.length > 0) {
          return {
            expiresAt: record.expires_at ? Number(record.expires_at) : null,
            refreshable: false,
            credential: record,
          }
        }
        const mcode = typeof record.mcode === 'string' ? record.mcode : typeof record.code === 'string' ? record.code : undefined
        if (!mcode) {
          throw new UpstreamError({ kind: 'NEEDS_MANUAL', message: 'importCredential expects { mcode } or a Loomy session blob' })
        }
        const session = sessions.get(accountId)
        if (!session?.msgid) {
          throw new UpstreamError({ kind: 'NEEDS_MANUAL', message: 'no pending SMS login; call beginLogin with a phone number first' })
        }
        const envelope = parseLoomyEnvelope(await postAccount(LOOMY_CHECK_CODE_PATH, loomyCheckCodeBody(session.phone, mcode, session.msgid)))
        if (!envelope.ok) {
          throw new UpstreamError({
            kind: envelope.code === '100002' ? 'AUTH_INVALID' : 'NEEDS_MANUAL',
            message: `checkCode failed (code ${envelope.code})`,
          })
        }
        const sessionValue =
          typeof envelope.data.session === 'string'
            ? envelope.data.session
            : typeof envelope.data.token === 'string'
              ? envelope.data.token
              : undefined
        if (!sessionValue) {
          throw new UpstreamError({ kind: 'TERMINAL', message: 'checkCode response carried no session' })
        }
        const credential: LoomyCredential = {
          access_token: sessionValue,
          expires_at: String(now() + SESSION_TTL_MS),
          phone: session.phone,
          ...(typeof envelope.data.uid === 'string' ? { uid: envelope.data.uid } : {}),
          ...(typeof envelope.data.nickname === 'string' ? { nickname: envelope.data.nickname } : {}),
        }
        session.credential = credential
        return { expiresAt: Number(credential.expires_at), refreshable: false, credential }
      },
    },
    ops: {
      async refreshAccount(_ctx, account): Promise<RefreshResult> {
        return {
          refreshable: isLoomyRefreshable(),
          expiresAt: null,
          refreshed: false,
          error: 'Loomy has no refresh endpoint; re-login (SMS) is required when the session expires',
        }
      },
      async getQuota(ctx, account): Promise<QuotaSnapshot> {
        const credential = await credentialOf(ctx, account)
        if (!credential) {
          return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now(), rawJson: null }
        }
        return fetchLoomyQuota({ product, credential, fetcher })
      },
      async claimCredits(ctx, account) {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { kind: 'needs_auth', message: 'no credential' }
        return claimLoomyDailyQuota({ product, credential, fetcher })
      },
      async healthCheck(ctx, account) {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { ok: false, error: 'no credential' }
        const res = await fetcher(`${product.apiBase}${LOOMY_MODELS_PATH}`, {
          headers: loomyBusinessHeaders(credential.access_token),
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
        let remote: ReturnType<typeof parseLoomyModels> = []
        if (credential) {
          const res = await fetcher(`${product.apiBase}${LOOMY_MODELS_PATH}`, {
            headers: loomyBusinessHeaders(credential.access_token),
          })
          if (res.ok) remote = parseLoomyModels(await res.json().catch(() => null))
        }
        const source = remote.length > 0 ? remote : product.fallbackModels.map((m) => ({ ...m }))
        return source.map((m) => ({
          modelId: modelIdOf(product.id, m.id),
          provider: product.id,
          upstreamModel: m.id,
          name: m.name,
          capabilities: { vision: false, toolCall: false, streaming: true },
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
