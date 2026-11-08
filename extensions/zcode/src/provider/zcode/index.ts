/**
 * ZCode provider facade（Extension Protocol v1）。
 *
 * 职责：把 zcode.z.ai 上游（Anthropic Messages 形态）桥接到协议形状。
 * 多账号语义与 workbuddycn 一致，并修复了审查中发现的三个问题：
 *
 *   1. re-enable 状态机：disable→enable 不再把有凭据的账号打成 pending
 *      （workbuddycn 的 bug：有凭据的账号会卡死在 pending，被池子排除）；
 *   2. 登录轮询单飞：GET /v1/accounts/:id 并发触发 advanceLogin 时，
 *      同账号共享一次上游 poll（workbuddycn 没有）；
 *   3. 模型缓存按账号隔离（store 层 schema 已带 account_id 主键）。
 *
 * ZCode 特性：凭据是静态的（coding-plan JWT 无刷新端点），
 * supportsRefreshToken=false；验证码为人工交接（auto-submit 缓存）。
 */
import type { AppConfig } from '../../util/config.js'
import type { Logger } from '../../util/logger.js'
import type { Store, ZCodeCredentialRecord, AccountRow } from '../../storage/store.js'
import { hasUsableCredential } from '../../storage/store.js'
import type {
  AccountStatus, ChatChunk, ChatResult, CreateAccountResponse, ExtensionAccount,
  ExtensionChatRequest, ProtocolModelInfo, QuotaSnapshotV1,
} from '../../protocol/types.js'
import { errors, ProtocolError } from '../../protocol/errors.js'
import {
  ZCODE_MODELS, MODEL_NAME_MAP,
  authHeaders, upstreamFor, bareModel,
} from './catalog.js'
import { ZCodeCaptchaManager, ZCodeCaptchaUnavailableError } from './captcha-store.js'
import { CaptchaService } from './captcha-service.js'
import type { Fetcher } from './upstream-auth.js'
import { fetchQuotaRaw } from './upstream-quota.js'
import { anthropicEventToChunk, fromAnthropicResponse, toAnthropicBody } from './anthropic.js'

export interface ProviderOptions {
  config: AppConfig
  store: Store
  logger: Logger
  fetcher?: Fetcher
  captcha?: ZCodeCaptchaManager
}

export interface ChatRuntimeContext {
  accountId: string
  requestId: string
  deadlineMs: number
  signal?: AbortSignal
}

interface LoginSession {
  flowId: string
  pollToken: string
  startedAt: number
}

/** 登录轮询的时间上限（与 Core 内置适配器一致：5 分钟） */
const LOGIN_TTL_MS = 5 * 60_000
/** 内置静态模型目录（zcode 无公开模型发现端点） */
const MODEL_TTL_MS = 10 * 60_000
const QUOTA_TTL_MS = 60_000

export class ZCodeProvider {
  private readonly apiBase: string
  private readonly sessions = new Map<string, LoginSession>()
  /** 登录轮询单飞（修复点 2）：同账号并发 GET 共享一次上游 poll */
  private readonly loginInFlight = new Map<string, Promise<void>>()
  private readonly captcha: ZCodeCaptchaManager
  private readonly fetcher: Fetcher

  readonly captchaService: CaptchaService

  constructor(private readonly opts: ProviderOptions) {
    this.apiBase = opts.config.upstreamApiBase
    this.captchaService = new CaptchaService({
      mode: opts.config.captchaMode,
      sceneId: opts.config.captchaSceneId,
      region: opts.config.captchaRegion,
      prefix: opts.config.captchaPrefix,
      poolMin: opts.config.captchaPoolMin,
      poolMax: opts.config.captchaPoolMax,
      solveConcurrency: opts.config.captchaSolveConcurrency,
      solveTimeoutMs: opts.config.captchaSolveTimeoutMs,
      cpuLimitPercent: opts.config.captchaCpuLimitPercent,
      log: (lvl, m) => opts.logger.log(lvl, m),
    })
    this.captcha = opts.captcha ?? new ZCodeCaptchaManager({ fetcher: opts.fetcher, configUrl: `${opts.config.upstreamApiBase}/client/configs?app_version=3.0.0&platform=win32` })
    this.fetcher = opts.fetcher ?? fetch.bind(globalThis)
  }

  getCaptcha(): ZCodeCaptchaManager {
    return this.captcha
  }

  /** 请求结束（含长流式）后调用：刷新 auto 池的活跃时钟 */
  touchCaptcha(): void {
    this.captchaService.touch()
  }

  async shutdownCaptcha(): Promise<void> {
    await this.captchaService.shutdown()
  }

  // ── 上游请求（Anthropic Messages）──────────────────────
  private chatHeaders(credential: ZCodeCredentialRecord, verifyParam: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...authHeaders(credential),
      'anthropic-version': '2023-06-01',
      'User-Agent': 'ZCode/3.0.1',
      'X-ZCode-App-Version': '3.0.1',
      'X-ZCode-Agent': 'glm',
      'HTTP-Referer': 'https://zcode.z.ai/',
    }
    if (verifyParam) headers['X-Aliyun-Captcha-Verify-Param'] = verifyParam
    return headers
  }

  /**
   * POST 上游 Anthropic 端点。
   * 挑战检测（403 头变体 / 3007 体变体）→ captcha.invalidate + 抛
   * ZCodeCaptchaUnavailableError，让 sendWithRetry 走一次 resolve+retry。
   */
  private async postMessages(
    credential: ZCodeCredentialRecord,
    req: ExtensionChatRequest,
    upstreamModel: string,
    verifyParam: string | null,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.fetcher(upstreamFor(credential, this.apiBase), {
      method: 'POST',
      headers: this.chatHeaders(credential, verifyParam),
      body: JSON.stringify(toAnthropicBody(req, upstreamModel)),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) {
      const challenge = await detectChallenge(response)
      if (challenge) {
        this.captcha.invalidate()
        throw new ZCodeCaptchaUnavailableError('expired', `captcha rejected by upstream (${challenge})`)
      }
      throw await toUpstreamError(response)
    }
    return response
  }

  /**
   * 完整重试流（与内置适配器 sendWithRetry 同构）：
   * 第一次带缓存令牌（可能根本没有 —— 条件验证码）；
   * 被拒后 invalidate → 人工交接 → 一次重试。
   * 人工交接走 waitForToken 单飞等待：运维者在授权页提交后所有并发请求立即恢复。
   */
  private async sendWithRetry(
    credential: ZCodeCredentialRecord,
    req: ExtensionChatRequest,
    upstreamModel: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    let verifyParam: string | null = null
    if (this.captchaService.mode === 'auto') {
      try {
        verifyParam = await this.captchaService.acquire()
      } catch {
        // auto 取不到（池冷启动中/上游禁用）→ 条件验证码允许无令牌首发
        verifyParam = this.captcha.peek()
      }
    } else {
      verifyParam = this.captcha.peek()
    }
    try {
      return await this.postMessages(credential, req, upstreamModel, verifyParam, signal)
    } catch (err) {
      if (!(err instanceof ZCodeCaptchaUnavailableError)) throw err
      // 挑战重试的令牌来源按模式分流：
      //   auto  → happy-dom 求解池（亚毫秒命中 / 同步抢解 / 有界重试）
      //   manual → 单飞等待人工提交（授权页 /v1/captcha）
      // 两者都失败 → NEEDS_CAPTCHA，绝不裸发。
      let fresh: string | null = null
      if (this.captchaService.mode === 'auto') {
        try {
          fresh = await this.captchaService.acquire()
        } catch (autoErr) {
          this.opts.logger.warn('captcha.auto.miss', { error: (autoErr as Error).message })
        }
      }
      if (fresh === null) {
        const budget = Math.max(1, Math.min(this.opts.config.captchaWaitMs, deadlineRemainingMs(req)))
        try {
          fresh = await this.captcha.waitForToken(budget)
        } catch {
          throw errors.needsCaptcha(
            'zcode captcha token unavailable; complete the verification at GET /v1/captcha and submit it, then retry',
          )
        }
      }
      return this.postMessages(credential, req, upstreamModel, fresh, signal)
    }
  }

  async chat(req: ExtensionChatRequest, ctx: ChatRuntimeContext): Promise<ChatResult> {
    const credential = this.requireCredential(ctx.accountId)
    const upstreamModel = MODEL_NAME_MAP[bareModel(req.model)] ?? bareModel(req.model)
    try {
      const response = await this.sendWithRetry(credential, { ...req, stream: false }, upstreamModel, ctx.signal)
      let payload: Record<string, unknown>
      try {
        payload = (await response.json()) as Record<string, unknown>
      } catch {
        throw errors.emptyResponse('zcode: non-JSON response body')
      }
      return fromAnthropicResponse(payload)
    } catch (err) {
      throw toProtocol(err)
    }
  }

  async *chatStream(req: ExtensionChatRequest, ctx: ChatRuntimeContext): AsyncIterable<ChatChunk> {
    const credential = this.requireCredential(ctx.accountId)
    const upstreamModel = MODEL_NAME_MAP[bareModel(req.model)] ?? bareModel(req.model)
    let response: Response
    try {
      response = await this.sendWithRetry(credential, { ...req, stream: true }, upstreamModel, ctx.signal)
    } catch (err) {
      throw toProtocol(err)
    }
    if (!response.body) throw errors.emptyResponse('zcode: empty response body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawFinish = false
    try {
      for (;;) {
        if (ctx.signal?.aborted) throw errors.transport('request cancelled locally')
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
              } catch (err) {
                if (err instanceof ProtocolError) throw err
                if (err instanceof ZCodeCaptchaUnavailableError) throw errors.needsCaptcha(err.message)
              }
            }
          }
          index = buffer.indexOf('\n')
        }
      }
    } finally {
      reader.cancel().catch(() => undefined)
    }
    if (!sawFinish) yield { text: '', finishReason: 'stop' }
  }

  private requireCredential(accountId: string): ZCodeCredentialRecord {
    const row = this.opts.store.getAccount(accountId)
    if (!row) throw errors.terminal(`unknown account ${accountId}`, { responseStatus: 404 })
    if (!row.enabled) throw errors.authInvalid(`account ${accountId} is disabled`, { httpStatus: 409 })
    const credential = this.opts.store.getCredential(accountId)
    if (!credential || !hasUsableCredential(credential)) {
      throw errors.authInvalid(`account ${accountId} has no usable credential`)
    }
    return credential
  }

  // ── 账号生命周期 ──────────────────────────────────────
  async createAccount(input: { accountId?: string; displayName?: string }): Promise<CreateAccountResponse> {
    const accountId = input.accountId ?? fallbackAccountId()
    // 预占会话槽：beginLogin 在下一段（router 侧 oauth 流程）填充。
    // 这里先落 pending 行，保证 account id 在 extension 侧可寻址。
    this.opts.store.createPendingAccount({
      id: accountId,
      provider_id: 'zcode',
      display_name: input.displayName,
      auth_started_at: Date.now(),
    })
    return {
      accountId,
      status: 'pending',
      authorizationUrl: null,
      expiresIn: Math.round(LOGIN_TTL_MS / 1000),
      pollInterval: 2,
    }
  }

  /**
   * 启动 OAuth CLI 流程（POST /v1/accounts/:id/login）。
   * zcode 的登录是「CLI init → 浏览器授权 → poll」两段式，
   * 与 workbuddycn 的一次性 authorizationUrl 不同：init 在这里发生，
   * authorizeUrl 存到账号行上，由 GET /v1/accounts/:id 返回。
   */
  async beginLogin(accountId: string): Promise<{ authorizeUrl: string; expiresIn: number; pollInterval: number }> {
    const row = this.opts.store.getAccount(accountId)
    if (!row) throw errors.terminal(`unknown account ${accountId}`, { responseStatus: 404 })
    const { startOAuth, randomPollToken } = await import('./upstream-auth.js')
    const pollToken = randomPollToken()
    const flow = await startOAuth(pollToken, this.fetcher, undefined, this.apiBase)
    this.sessions.set(accountId, { flowId: flow.flowId, pollToken, startedAt: Date.now() })
    this.opts.store.createPendingAccount({
      id: accountId,
      provider_id: 'zcode',
      display_name: row.display_name,
      auth_state: flow.flowId,
      auth_url: flow.authorizeUrl,
      auth_started_at: Date.now(),
    })
    const expiresIn = flow.expiresAt
      ? Math.max(30, Math.min(600, Math.round((flow.expiresAt - Date.now()) / 1000)))
      : Math.round(LOGIN_TTL_MS / 1000)
    return { authorizeUrl: flow.authorizeUrl, expiresIn, pollInterval: flow.pollInterval ?? 2 }
  }

  async listAccounts(): Promise<ExtensionAccount[]> {
    return this.opts.store.listAccounts().map((row) => this.project(row))
  }

  async getAccount(accountId: string): Promise<ExtensionAccount | undefined> {
    const row = this.opts.store.getAccount(accountId)
    if (!row) return undefined
    if (row.status === 'pending' && row.auth_state) {
      await this.advanceLoginOnce(accountId)
    }
    const refreshed = this.opts.store.getAccount(accountId) ?? row
    return this.project(refreshed)
  }

  /**
   * 登录轮询单飞：并发 GET /v1/accounts/:id 只触发一次上游 poll。
   * 与 refresh 单飞同构（zcode 的 pollOAuth 自带 429/5xx 重试，这里防的是并发重复）。
   */
  private advanceLoginOnce(accountId: string): Promise<void> {
    const existing = this.loginInFlight.get(accountId)
    if (existing) return existing
    const attempt = this.advanceLogin(accountId).finally(() => this.loginInFlight.delete(accountId))
    this.loginInFlight.set(accountId, attempt)
    return attempt
  }

  private async advanceLogin(accountId: string): Promise<void> {
    const row = this.opts.store.getAccount(accountId)
    if (!row?.auth_state) return
    const startedAt = row.auth_started_at ?? Date.now()
    if (Date.now() - startedAt > LOGIN_TTL_MS) {
      this.opts.store.setAccountStatus(accountId, 'auth_failed', 'login timed out')
      this.opts.store.setAccountLoginMeta(accountId, undefined, undefined)
      this.sessions.delete(accountId)
      return
    }
    const session = this.sessions.get(accountId)
    if (!session) {
      // 进程重启后内存会话丢失 —— 无法继续 poll，标记需要重新登录
      this.opts.store.setAccountStatus(accountId, 'auth_failed', 'login session lost (restart); re-login required')
      this.opts.store.setAccountLoginMeta(accountId, undefined, undefined)
      return
    }
    const { pollOAuth, ZCodePollRateLimitedError } = await import('./upstream-auth.js')
    let result
    try {
      result = await pollOAuth(session.flowId, session.pollToken, this.fetcher, undefined, { baseUrl: this.apiBase })
    } catch (err) {
      if (err instanceof ZCodePollRateLimitedError) return // 瞬时限流：保持 pending
      const pe = toProtocol(err)
      if (pe.kind === 'AUTH_INVALID' || pe.kind === 'TERMINAL') {
        this.opts.store.setAccountStatus(accountId, 'auth_failed', pe.message)
        this.opts.store.setAccountLoginMeta(accountId, undefined, undefined)
        this.sessions.delete(accountId)
      }
      return
    }
    if (!result.ready) return
    const credential: ZCodeCredentialRecord = {
      jwt_token: result.jwtToken,
      oauth_access_token: result.accessToken,
      nickname: result.nickname,
    }
    this.opts.store.saveCredential(accountId, credential)
    this.opts.store.setAccountStatus(accountId, 'active')
    this.opts.store.setAccountLoginMeta(accountId, undefined, undefined)
    if (result.nickname) this.opts.store.setDisplayName(accountId, result.nickname)
    this.sessions.delete(accountId)
    this.opts.logger.info('login.success', { account_id: accountId })
  }

  /** import 模式：运维者直接粘贴 jwt_token / api_key（幂等，可覆盖） */
  async importCredential(accountId: string, payload: unknown): Promise<{ accepted: boolean; status: AccountStatus }> {
    const row = this.opts.store.getAccount(accountId)
    if (!row) throw errors.terminal(`unknown account ${accountId}`, { responseStatus: 404 })
    const record = (payload ?? {}) as Record<string, unknown>
    const pick = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = record[key]
        if (typeof value === 'string' && value.trim().length > 0) return value.trim()
      }
      return undefined
    }
    const credential: ZCodeCredentialRecord = {
      jwt_token: pick('jwt_token', 'jwtToken', 'zcodejwttoken', 'zai_token'),
      api_key: pick('api_key', 'apiKey'),
      oauth_access_token: pick('oauth_access_token', 'access_token'),
      oauth_refresh_token: pick('oauth_refresh_token', 'refresh_token'),
      nickname: pick('nickname'),
    }
    if (!hasUsableCredential(credential)) {
      throw errors.terminal('zcode credential needs jwt_token/zcodejwttoken or api_key', { responseStatus: 422 })
    }
    this.opts.store.saveCredential(accountId, credential)
    this.opts.store.setAccountStatus(accountId, 'active')
    if (credential.nickname) this.opts.store.setDisplayName(accountId, credential.nickname)
    return { accepted: true, status: 'active' }
  }

  /**
   * re-enable 状态机（修复点 1）：
   *   - disable → 恒为 disabled；
   *   - enable → 有可用凭据恢复 active；无凭据才回 pending。
   * workbuddycn 的版本把有凭据的账号打成 pending 且无人推进，账号就此卡死。
   */
  async setEnabled(accountId: string, enabled: boolean): Promise<{ accepted: boolean; status: AccountStatus }> {
    const row = this.opts.store.getAccount(accountId)
    if (!row) throw errors.terminal(`unknown account ${accountId}`, { responseStatus: 404 })
    this.opts.store.setAccountEnabled(accountId, enabled)
    let status: AccountStatus
    if (!enabled) {
      status = 'disabled'
    } else if (hasUsableCredential(this.opts.store.getCredential(accountId))) {
      status = 'active'
    } else {
      status = 'pending'
    }
    this.opts.store.setAccountStatus(accountId, status)
    return { accepted: true, status }
  }

  /** ZCode 凭据静态：无刷新端点，refresh 仅做健康检查语义 */
  async refresh(accountId: string): Promise<{ status: AccountStatus; refreshed: boolean; error: string | null }> {
    const row = this.opts.store.getAccount(accountId)
    if (!row) throw errors.terminal(`unknown account ${accountId}`, { responseStatus: 404 })
    const credential = this.opts.store.getCredential(accountId)
    if (!credential || !hasUsableCredential(credential)) {
      this.opts.store.setAccountStatus(accountId, 'auth_failed', 'no credential')
      return { status: 'auth_failed', refreshed: false, error: 'no credential' }
    }
    // 用配额端点做一次轻量健康检查（不改变凭据）
    try {
      const quota = await fetchQuotaRaw(credential, this.fetcher, this.apiBase)
      const status: AccountStatus = 'active'
      this.opts.store.setAccountStatus(accountId, status)
      return { status, refreshed: false, error: null }
    } catch (err) {
      const pe = toProtocol(err)
      if (pe.kind === 'AUTH_INVALID') {
        this.opts.store.setAccountStatus(accountId, 'auth_failed', pe.message)
        return { status: 'auth_failed', refreshed: false, error: pe.message }
      }
      return { status: row.status, refreshed: false, error: pe.message }
    }
  }

  async deleteAccount(accountId: string): Promise<void> {
    this.sessions.delete(accountId)
    this.opts.store.deleteAccount(accountId)
    this.opts.logger.info('account.delete', { account_id: accountId })
  }

  // ── models / quota ────────────────────────────────────
  async models(accountId: string): Promise<{ models: ProtocolModelInfo[]; source: string }> {
    const cached = this.opts.store.getModelCache(accountId)
    if (cached && Date.now() - cached.fetchedAt < MODEL_TTL_MS) {
      try {
        return { models: JSON.parse(cached.payload) as ProtocolModelInfo[], source: 'cached' }
      } catch {
        /* fall through to static */
      }
    }
    // zcode 无公开模型发现端点：内置静态目录（与 Core 内置适配器一致），
    // 但缓存按账号写，未来接发现端点时不同账号的目录不会互相覆盖。
    const models = ZCODE_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      capabilities: { vision: false, toolCall: true, streaming: true },
    }))
    this.opts.store.putModelCache(accountId, JSON.stringify(models))
    return { models, source: 'static' }
  }

  async quota(accountId: string, preferCache = false): Promise<QuotaSnapshotV1> {
    const row = this.opts.store.getAccount(accountId)
    if (!row) throw errors.terminal(`unknown account ${accountId}`, { responseStatus: 404 })
    const now = Date.now()
    if (preferCache) {
      const cached = this.opts.store.getQuotaCache(accountId)
      if (cached && now - cached.fetchedAt < QUOTA_TTL_MS) {
        try {
          return JSON.parse(cached.payload) as QuotaSnapshotV1
        } catch {
          /* fall through */
        }
      }
    }
    const credential = this.opts.store.getCredential(accountId)
    if (!credential || !hasUsableCredential(credential)) {
      throw errors.authInvalid(`account ${accountId} has no usable credential`)
    }
    const raw = await fetchQuotaRaw(credential, this.fetcher, this.apiBase)
    const snapshot: QuotaSnapshotV1 = {
      accountId,
      checkedAt: new Date(raw.lastUpdatedAt).toISOString(),
      source: raw.known ? 'authoritative' : 'estimate',
      resources: [
        {
          id: 'coding-plan',
          kind: 'tokens',
          unit: 'requests',
          // 声明式契约：缺失数据保持缺失（null），不伪造 0
          remaining: raw.remaining,
          total: raw.total,
          used: null,
          resetAt: raw.resetAt ? new Date(raw.resetAt).toISOString() : null,
          status: statusOf(raw),
        },
      ],
    }
    if (raw.known) this.opts.store.putQuotaCache(accountId, JSON.stringify(snapshot))
    return snapshot
  }

  private project(row: AccountRow): ExtensionAccount {
    const credential = this.opts.store.getCredential(row.id)
    const metadata: Record<string, unknown> = {
      credentialKind: credential?.jwt_token ? 'jwt_token' : credential?.api_key ? 'api_key' : 'none',
      authUrl: row.auth_url ?? null,
    }
    return {
      accountId: row.id,
      providerId: 'zcode',
      displayName: row.display_name ?? row.id,
      status: row.status,
      manualAction: null,
      quota: null,
      lastError: row.last_error ?? null,
      lastSuccessAt: row.last_success_at ?? null,
      lastFailureAt: row.last_failure_at ?? null,
      metadata,
    }
  }
}

// ── helpers ───────────────────────────────────────────────

function statusOf(raw: { known: boolean; remaining: number | null; total: number | null }): 'ok' | 'low' | 'exhausted' | 'unknown' {
  if (!raw.known) return 'unknown'
  if (raw.remaining !== null && raw.total !== null && raw.total > 0) {
    if (raw.remaining <= 0) return 'exhausted'
    if (raw.remaining / raw.total < 0.15) return 'low'
  }
  return 'ok'
}

function fallbackAccountId(): string {
  return `zcode-${Math.random().toString(16).slice(2, 10)}`
}

function deadlineRemainingMs(req: ExtensionChatRequest): number {
  return req.deadlineMs - Date.now()
}

/** 上游挑战检测：403 + verify-param 头变体；400 + {"code":3007} 体变体 */
async function detectChallenge(response: Response): Promise<string | null> {
  const header = response.headers.get('x-aliyun-captcha-verify-param')
  if (header && header.trim().length > 0) return 'header'
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) return null
  try {
    const text = (await response.clone().text()).slice(0, 64 * 1024)
    if (text.includes('"code":3007') || text.includes('"code": 3007')) return 'in_body_3007'
  } catch {
    /* body 不可读 */
  }
  return null
}

async function toUpstreamError(response: Response): Promise<ProtocolError> {
  let text = ''
  try {
    text = (await response.clone().text()).slice(0, 300)
  } catch {
    /* ignore */
  }
  const lower = text.toLowerCase()
  if (response.status === 401) return errors.authInvalid(`zcode auth error: ${text}`, { httpStatus: 401 })
  if (response.status === 403) return errors.authInvalid(`zcode forbidden: ${text}`, { httpStatus: 403 })
  if (response.status === 429) return errors.rateLimit(`zcode rate limited: ${text}`, { httpStatus: 429 })
  if (lower.includes('balance') || lower.includes('quota') || lower.includes('insufficient')) {
    return errors.quotaExhausted(`zcode quota exhausted: ${text}`, { httpStatus: response.status })
  }
  if (response.status >= 500) return errors.upstream5xx(`zcode upstream ${response.status}`, { httpStatus: response.status })
  return errors.terminal(`zcode HTTP ${response.status}: ${text}`, { httpStatus: response.status })
}

function toProtocol(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error
  if (error instanceof ZCodeCaptchaUnavailableError) {
    return errors.needsCaptcha(`zcode requires a captcha token (${error.kind}); complete the verification at GET /v1/captcha and submit it`)
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|abort/i.test(message)) return errors.timeout(message)
  return errors.transport(message)
}
