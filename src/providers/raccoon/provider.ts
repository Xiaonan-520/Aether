/**
 * Raccoon Work (商汤小浣熊) provider adapter.
 *
 * Auth policy: **only the WeChat QR path is implemented.** The SMS path requires
 * an Aliyun slider captcha (`captcha_param`) which this gateway will not solve,
 * spoof or bypass, so requesting SMS returns `needs_manual_action` and no
 * attempt is made.
 *
 * Chat is standard OpenAI-compatible SSE.
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
  RACCOON,
  RACCOON_CHAT_PATH,
  RACCOON_LOGIN_SMS_PATH,
  RACCOON_LOGIN_TIMEOUT_MS,
  RACCOON_MODEL_CATALOG_PATH,
  RACCOON_QR_LOGIN_PATH,
  RACCOON_REFRESH_PATH,
  RACCOON_SEND_SMS_PATH,
  RACCOON_USER_INFO_PATH,
  type RaccoonProduct,
} from './product.js'
import {
  buildQrImageUrl,
  generateQrCode,
  isRaccoonRefreshable,
  mergeRaccoonCredential,
  parseRaccoonEnvelope,
  parseRaccoonModelCatalog,
  raccoonAuthHeaders,
  raccoonCredentialExpiresAtMs,
  type Fetcher,
  type RaccoonCredential,
  type RaccoonQrStatus,
} from './protocol.js'
import { claimRaccoonLoginReward, fetchRaccoonBalance } from './credits.js'

/** Raccoon QR status codes (verified reference). */
const QR_STATUS: Readonly<Record<number, RaccoonQrStatus>> = { 1: 'pending', 2: 'logging', 3: 'canceled', 4: 'success' }

export interface RaccoonProviderOptions {
  product?: RaccoonProduct
  fetcher?: Fetcher
  now?: () => number
}

interface LoginSession {
  qrcodeCode: string
  qrUrl: string
  startedAt: number
  lastStatus: RaccoonQrStatus
}

export function createRaccoonProvider(options: RaccoonProviderOptions = {}): Provider {
  const product = options.product ?? RACCOON
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now
  const sessions = new Map<string, LoginSession>()

  const capabilities: ProviderCapabilities = {
    supportsOAuth: true,
    supportsRefreshToken: true,
    supportsQuota: true,
    supportsCredits: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsToolCall: false,
    supportsMultipleAccounts: true,
    // the QR path needs no captcha; the SMS path is refused rather than solved
    needsCaptcha: false,
    loginMode: 'external-link',
    protocol: 'openai-chat',
  }

  async function credentialOf(ctx: ProviderCtx, account: Account): Promise<RaccoonCredential | undefined> {
    const handle = await ctx.resolveCredential(account)
    return handle?.credential as RaccoonCredential | undefined
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

  async function* streamChat(ctx: ProviderCtx, account: Account, req: ChatRequest): AsyncIterable<ChatChunk> {
    const credential = await credentialOf(ctx, account)
    if (!credential?.access_token) {
      throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'account has no Raccoon access token' })
    }
    const body: Record<string, unknown> = {
      model: bareModel(req.model),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    }
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    const res = await fetcher(`${product.apiBase}${product.llmApiPrefix}${RACCOON_CHAT_PATH}`, {
      method: 'POST',
      headers: raccoonAuthHeaders(credential, product),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw classify(res.status, `Raccoon chat failed (HTTP ${res.status})`)
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
      /** QR login: generate a code and hand back the WeChat login page URL. */
      async beginLogin(input): Promise<BeginLoginResult> {
        const qrcodeCode = generateQrCode()
        const qrUrl = buildQrImageUrl(product, qrcodeCode)
        sessions.set(input.accountId, { qrcodeCode, qrUrl, startedAt: now(), lastStatus: 'pending' })
        return { loginUrl: qrUrl, expiresIn: Math.floor(RACCOON_LOGIN_TIMEOUT_MS / 1000), pollInterval: 2 }
      },
      async pollLogin(accountId): Promise<PollLoginResult> {
        const session = sessions.get(accountId)
        if (!session) return { done: false, error: 'login session not found or expired' }
        if (now() - session.startedAt > RACCOON_LOGIN_TIMEOUT_MS) {
          sessions.delete(accountId)
          return { done: true, success: false, error: 'QR code expired' }
        }
        try {
          const res = await fetcher(`${product.apiBase}${product.authApiPrefix}${RACCOON_QR_LOGIN_PATH}`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': product.userAgent },
            body: JSON.stringify({ qrcode_code: session.qrcodeCode }),
          })
          const envelope = parseRaccoonEnvelope(await res.json().catch(() => null))
          if (!envelope.ok) {
            // any anomaly degrades to pending, never a spurious failure
            session.lastStatus = 'pending'
            return { done: false }
          }
          const rawStatus = typeof envelope.data.status === 'number' ? envelope.data.status : undefined
          const status: RaccoonQrStatus = rawStatus !== undefined ? (QR_STATUS[rawStatus] ?? 'pending') : 'pending'
          session.lastStatus = status
          if (status === 'canceled') {
            sessions.delete(accountId)
            return { done: true, success: false, error: 'QR login canceled by user' }
          }
          if (status !== 'success') return { done: false }
          const accessToken = typeof envelope.data.access_token === 'string' ? envelope.data.access_token : ''
          // a success without a token is still pending, not a failure
          if (accessToken.length === 0) return { done: false }
          const credential = mergeRaccoonCredential(envelope.data, { device_id: session.qrcodeCode })
          sessions.delete(accountId)
          return {
            done: true,
            success: true,
            credential,
            expiresAt: raccoonCredentialExpiresAtMs(credential) ?? null,
            ...(credential.nickname ? { displayName: credential.nickname } : {}),
          }
        } catch {
          session.lastStatus = 'pending'
          return { done: false }
        }
      },
      async importCredential(accountId, _provider, payload) {
        const record = (payload ?? {}) as Record<string, unknown>
        // SMS login is refused: it needs an Aliyun slider captcha, which the
        // gateway will not solve or bypass.
        if (record.sms === true || typeof record.phone === 'string') {
          throw new UpstreamError({
            kind: 'NEEDS_MANUAL',
            message:
              'Raccoon SMS login requires an Aliyun slider captcha, which is not solved or bypassed here; use the WeChat QR flow instead',
          })
        }
        if (typeof record.access_token === 'string' && record.access_token.length > 0) {
          const credential = mergeRaccoonCredential(record, record as Partial<RaccoonCredential>)
          sessions.delete(accountId)
          return {
            expiresAt: raccoonCredentialExpiresAtMs(credential) ?? null,
            refreshable: isRaccoonRefreshable(credential),
            credential,
          }
        }
        throw new UpstreamError({
          kind: 'NEEDS_MANUAL',
          message: 'importCredential expects a Raccoon credential blob (use the QR flow to obtain one)',
        })
      },
    },
    ops: {
      async refreshAccount(ctx, account): Promise<RefreshResult> {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { refreshable: false, expiresAt: null, refreshed: false, error: 'no credential' }
        if (!isRaccoonRefreshable(credential)) {
          return { refreshable: false, expiresAt: null, refreshed: false, error: 'not refreshable' }
        }
        const res = await fetcher(`${product.apiBase}${product.authApiPrefix}${RACCOON_REFRESH_PATH}`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': product.userAgent },
          body: JSON.stringify({ refresh_token: credential.refresh_token }),
        })
        const envelope = parseRaccoonEnvelope(await res.json().catch(() => null))
        if (!envelope.ok || typeof envelope.data.access_token !== 'string') {
          throw new UpstreamError({
            kind: res.status === 401 || res.status === 403 ? 'AUTH_INVALID' : 'TERMINAL',
            status: res.status,
            message: `Raccoon refresh failed (HTTP ${res.status})`,
          })
        }
        // keep the old refresh token when the server omits a new one
        const updated = mergeRaccoonCredential(envelope.data, credential)
        return {
          refreshable: isRaccoonRefreshable(updated),
          expiresAt: raccoonCredentialExpiresAtMs(updated) ?? null,
          refreshed: true,
          credential: updated,
        }
      },
      async getQuota(ctx, account): Promise<QuotaSnapshot> {
        const credential = await credentialOf(ctx, account)
        if (!credential) {
          return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now(), rawJson: null }
        }
        return fetchRaccoonBalance({ product, credential, fetcher })
      },
      async claimCredits(ctx, account) {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { kind: 'needs_auth', message: 'no credential' }
        return claimRaccoonLoginReward({ product, credential, fetcher })
      },
      async healthCheck(ctx, account) {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { ok: false, error: 'no credential' }
        const res = await fetcher(`${product.apiBase}${product.authApiPrefix}${RACCOON_USER_INFO_PATH}`, {
          headers: raccoonAuthHeaders(credential, product),
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
        let remote: ReturnType<typeof parseRaccoonModelCatalog> = []
        if (credential) {
          const res = await fetcher(`${product.apiBase}${product.llmApiPrefix}${RACCOON_MODEL_CATALOG_PATH}`, {
            headers: raccoonAuthHeaders(credential, product),
          })
          if (res.ok) remote = parseRaccoonModelCatalog(await res.json().catch(() => null))
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

export { RACCOON_SEND_SMS_PATH, RACCOON_LOGIN_SMS_PATH, parseRaccoonEnvelope }
