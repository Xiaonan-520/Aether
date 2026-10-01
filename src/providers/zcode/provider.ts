/**
 * ZCode provider (Z.AI coding plan, Anthropic Messages upstream).
 *
 * Captcha policy: requests carry the cached `X-Aliyun-Captcha-Verify-Param`
 * token. When no token is cached the adapter fails with NEEDS_CAPTCHA instead
 * of trying to solve it; an operator supplies a token obtained from a normal
 * browser session. Captcha 403s invalidate the cache and surface the same
 * error so the caller can prompt again — never an automatic solve.
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
  BeginLoginInput,
  BeginLoginResult,
  PollLoginResult,
  Provider,
  ProviderCtx,
  RefreshResult,
} from '../../core/registry/provider.js'
import { UpstreamError } from '../../core/errors/upstream-error.js'
import { ZCodeCaptchaManager, ZCodeCaptchaUnavailableError } from './captcha.js'
import {
  ZCodePollRateLimitedError,
  ZCODE_QUOTA,
  authHeaders,
  normalizeImportedCredential,
  pollOAuth,
  randomPollToken,
  startOAuth,
  upstreamFor,
  type Fetcher,
  type ZCodeCredential,
} from './auth.js'
import { anthropicEventToChunk, fromAnthropicResponse, toAnthropicBody } from './anthropic.js'

const USER_AGENT = 'ZCode/3.0.1'

/** Static catalog: /v3-style remote discovery is not exposed by Z.AI. */
const ZCODE_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5.1', name: 'GLM-5.1' },
  { id: 'glm-5-turbo', name: 'GLM-5 Turbo' },
  { id: 'glm-4.7', name: 'GLM-4.7' },
]

/** Upstream is case-sensitive about model names. */
const MODEL_NAME_MAP: Readonly<Record<string, string>> = {
  'glm-5.2': 'GLM-5.2',
  'glm-5.1': 'GLM-5.1',
  'glm-5-turbo': 'GLM-5-Turbo',
  'glm-4.7': 'GLM-4.7',
}

interface LoginSession {
  flowId: string
  pollToken: string
  authUrl: string
  startedAt: number
}

export interface ZCodeProviderOptions {
  captcha?: ZCodeCaptchaManager
  fetcher?: Fetcher
  /** max captcha retries per request (mirrors the reference bridge) */
  maxCaptchaRetries?: number
}

export function createZCodeProvider(options: ZCodeProviderOptions = {}): Provider {
  const fetcher = options.fetcher ?? fetch
  const captcha = options.captcha ?? new ZCodeCaptchaManager()
  const maxCaptchaRetries = options.maxCaptchaRetries ?? 3
  const sessions = new Map<string, LoginSession>()

  const capabilities: ProviderCapabilities = {
    supportsOAuth: true,
    // ZCode credentials are static (reference: ZCODE_REFRESHABLE=false).
    supportsRefreshToken: false,
    supportsQuota: true,
    // Claim requires the same captcha and is not implemented in 3B.
    supportsCredits: false,
    supportsStreaming: true,
    supportsVision: false,
    supportsToolCall: true,
    supportsMultipleAccounts: true,
    needsCaptcha: true,
    loginMode: 'oauth',
    protocol: 'anthropic-messages',
  }

  async function credentialOf(ctx: ProviderCtx, account: Account): Promise<ZCodeCredential | undefined> {
    const handle = await ctx.resolveCredential(account)
    return handle?.credential as ZCodeCredential | undefined
  }

  function bareModel(model: string): string {
    const sep = model.indexOf('::')
    return sep > 0 ? model.slice(sep + 2) : model
  }

  function chatHeaders(credential: ZCodeCredential, verifyParam: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...authHeaders(credential),
      'anthropic-version': '2023-06-01',
      'User-Agent': USER_AGENT,
      'X-ZCode-App-Version': '3.0.1',
      'X-ZCode-Agent': 'glm',
      'HTTP-Referer': 'https://zcode.z.ai/',
    }
    if (verifyParam) headers['X-Aliyun-Captcha-Verify-Param'] = verifyParam
    return headers
  }

  async function postMessages(
    credential: ZCodeCredential,
    req: ChatRequest,
    upstreamModel: string,
    verifyParam: string,
  ): Promise<Response> {
    const response = await fetcher(upstreamFor(credential), {
      method: 'POST',
      headers: chatHeaders(credential, verifyParam),
      body: JSON.stringify(toAnthropicBody(req, upstreamModel)),
    })
    if (response.status === 403 && (await looksLikeCaptchaError(response))) {
      captcha.invalidate()
      throw new ZCodeCaptchaUnavailableError('expired', 'captcha token rejected by upstream (403)')
    }
    if (!response.ok) throw await toUpstreamError(response)
    return response
  }

  async function looksLikeCaptchaError(response: Response): Promise<boolean> {
    try {
      const text = (await response.clone().text()).toLowerCase()
      return text.includes('captcha') || text.includes('verify token') || text.includes('verify failed')
    } catch {
      return false
    }
  }

  async function toUpstreamError(response: Response): Promise<UpstreamError> {
    let text = ''
    try {
      text = (await response.text()).slice(0, 300)
    } catch {
      text = ''
    }
    const lower = text.toLowerCase()
    if (response.status === 401) {
      return new UpstreamError({ kind: 'AUTH_INVALID', message: `zcode auth error: ${text}`, status: 401 })
    }
    if (response.status === 403) {
      return new UpstreamError({ kind: 'AUTH_INVALID', message: `zcode forbidden: ${text}`, status: 403 })
    }
    if (response.status === 429) {
      return new UpstreamError({ kind: 'RATE_LIMIT', message: `zcode rate limited: ${text}`, status: 429 })
    }
    if (lower.includes('balance') || lower.includes('quota') || lower.includes('insufficient')) {
      return new UpstreamError({ kind: 'QUOTA_EXHAUSTED', message: `zcode quota exhausted: ${text}`, status: response.status })
    }
    if (response.status >= 500) {
      return new UpstreamError({ kind: 'UPSTREAM_5XX', message: `zcode upstream ${response.status}`, status: response.status })
    }
    return new UpstreamError({ kind: 'TERMINAL', message: `zcode HTTP ${response.status}: ${text}`, status: response.status })
  }

  /** Map a captcha failure onto the canonical NEEDS_CAPTCHA upstream error. */
  function needsCaptchaError(err: ZCodeCaptchaUnavailableError): UpstreamError {
    return new UpstreamError({
      kind: 'NEEDS_CAPTCHA',
      message: `zcode requires a captcha token (${err.kind}); submit one via POST /api/accounts/zcode/captcha`,
      detail: err.kind,
    })
  }

  /** Resolve a captcha token or fail with NEEDS_CAPTCHA (never auto-solve). */
  function requireCaptcha(): string {
    try {
      return captcha.getToken()
    } catch (err) {
      if (err instanceof ZCodeCaptchaUnavailableError) throw needsCaptchaError(err)
      throw err
    }
  }

  async function fetchQuota(credential: ZCodeCredential): Promise<QuotaSnapshot> {
    const headers = { 'Content-Type': 'application/json', ...authHeaders(credential) }
    const now = Date.now()
    try {
      const [billingRes, balanceRes] = await Promise.all([
        fetcher(ZCODE_QUOTA.billing, { headers }),
        fetcher(ZCODE_QUOTA.balance, { headers }).catch(() => null),
      ])
      if (!billingRes.ok) {
        return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now, rawJson: null }
      }
      const billing = (await billingRes.json()) as Record<string, unknown>
      const balance = balanceRes?.ok ? ((await balanceRes.json()) as Record<string, unknown>) : null
      const data = (billing.data ?? billing) as Record<string, unknown>
      const remaining = firstNumber(data, ['remaining', 'available', 'left', 'balance'])
      const total = firstNumber(data, ['total', 'quota', 'limit'])
      const resetAt = firstNumber(data, ['resetAt', 'reset_at', 'expireAt', 'expires_at'])
      return {
        known: remaining !== null || total !== null,
        remaining,
        total,
        resetAt,
        lastUpdatedAt: now,
        rawJson: JSON.stringify({ billing, balance }),
      }
    } catch {
      return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now, rawJson: null }
    }
  }

  function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim())
    }
    return null
  }

  async function* streamMessages(
    credential: ZCodeCredential,
    req: ChatRequest,
    upstreamModel: string,
  ): AsyncGenerator<ChatChunk> {
    const response = await postMessages(credential, { ...req, stream: true }, upstreamModel, requireCaptcha())
    if (!response.body) throw new UpstreamError({ kind: 'EMPTY_RESPONSE', message: 'zcode: empty response body' })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawFinish = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload !== '' && payload !== '[DONE]') {
            try {
              const event = JSON.parse(payload) as Record<string, unknown>
              const chunk = anthropicEventToChunk(event)
              if (chunk) {
                if (chunk.finishReason) sawFinish = true
                yield chunk
              }
            } catch {
              // ignore malformed event
            }
          }
        }
        index = buffer.indexOf('\n')
      }
    }
    if (!sawFinish) yield { text: '', finishReason: 'stop' }
  }

  return {
    id: 'zcode',
    displayName: 'ZCode (Z.AI)',
    capabilities,
    auth: {
      async beginLogin(input: BeginLoginInput): Promise<BeginLoginResult> {
        const pollToken = randomPollToken()
        const flow = await startOAuth(pollToken, fetcher)
        sessions.set(input.accountId, {
          flowId: flow.flowId,
          pollToken,
          authUrl: flow.authorizeUrl,
          startedAt: Date.now(),
        })
        return { loginUrl: flow.authorizeUrl, expiresIn: 300, pollInterval: 2 }
      },
      async pollLogin(accountId: string): Promise<PollLoginResult> {
        const session = sessions.get(accountId)
        if (!session) return { done: false, error: 'login session not found or expired' }
        if (Date.now() - session.startedAt > 5 * 60_000) {
          sessions.delete(accountId)
          return { done: true, success: false, error: 'login timed out' }
        }
        let result
        try {
          result = await pollOAuth(session.flowId, session.pollToken, fetcher)
        } catch (err) {
          // A rate-limited poll is transient: report pending with a structured
          // message instead of throwing an unhandled error out of the HTTP layer.
          if (err instanceof ZCodePollRateLimitedError) {
            return { done: false, error: `upstream rate limited; retry in ${Math.ceil(err.retryAfterMs / 1000)}s` }
          }
          throw err
        }
        if (!result.ready) return { done: false }
        sessions.delete(accountId)
        const credential: ZCodeCredential = {
          jwt_token: result.jwtToken,
          oauth_access_token: result.accessToken,
          nickname: result.nickname,
        }
        return {
          done: true,
          success: true,
          credential,
          // static credential: no refreshable expiry
          expiresAt: null,
          displayName: result.nickname,
        }
      },
      async importCredential(_accountId: string, _provider: string, payload: unknown) {
        const credential = normalizeImportedCredential(payload)
        return { expiresAt: null, refreshable: false, credential }
      },
    },
    ops: {
      async refreshAccount(): Promise<RefreshResult> {
        // Static credential — nothing to refresh.
        return { refreshable: false, expiresAt: null, refreshed: false }
      },
      async getQuota(ctx: ProviderCtx, account: Account): Promise<QuotaSnapshot> {
        const credential = await credentialOf(ctx, account)
        if (!credential) throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'zcode: no credential' })
        return fetchQuota(credential)
      },
      async healthCheck(ctx: ProviderCtx, account: Account): Promise<{ ok: boolean; error?: string }> {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { ok: false, error: 'no credential' }
        try {
          const quota = await fetchQuota(credential)
          return { ok: true, error: quota.known ? undefined : 'quota unknown' }
        } catch (err) {
          return { ok: false, error: String(err) }
        }
      },
    },
    chat: {
      async listModels(): Promise<ModelEntry[]> {
        return ZCODE_MODELS.map((model, index) => ({
          modelId: model.id,
          provider: 'zcode',
          upstreamModel: model.id,
          name: model.name,
          capabilities: { vision: false, toolCall: true, streaming: true },
          enabled: true,
          priority: 90 - index,
          metadataJson: null,
        }))
      },
      async chat(ctx: ProviderCtx, req: ChatRequest, account: Account, _tools?: Tool[]): Promise<ChatResult> {
        const credential = await credentialOf(ctx, account)
        if (!credential) throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'zcode: no credential' })
        const model = bareModel(req.model)
        const upstreamModel = MODEL_NAME_MAP[model.toLowerCase()] ?? model
        let lastError: unknown
        for (let attempt = 0; attempt < maxCaptchaRetries; attempt++) {
          try {
            const response = await postMessages(credential, { ...req, stream: false }, upstreamModel, requireCaptcha())
            return fromAnthropicResponse((await response.json()) as Record<string, unknown>)
          } catch (err) {
            lastError = err
            if (err instanceof ZCodeCaptchaUnavailableError) continue
            throw err
          }
        }
        if (lastError instanceof ZCodeCaptchaUnavailableError) throw needsCaptchaError(lastError)
        throw lastError
      },
      stream(ctx: ProviderCtx, req: ChatRequest, account: Account, _tools?: Tool[]): AsyncIterable<ChatChunk> {
        const model = bareModel(req.model)
        const upstreamModel = MODEL_NAME_MAP[model.toLowerCase()] ?? model
        return (async function* (): AsyncGenerator<ChatChunk> {
          const credential = await credentialOf(ctx, account)
          if (!credential) throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'zcode: no credential' })
          yield* streamMessages(credential, req, upstreamModel)
        })()
      },
    },
  }
}

export { ZCodeCaptchaManager } from './captcha.js'
