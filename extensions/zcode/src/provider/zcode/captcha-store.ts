/**
 * 人工提交的验证码令牌缓存（单飞 + TTL + 拒绝即失效）。
 *
 * 与 Core 内置适配器的 ZCodeCaptchaManager 行为一致：
 *  - 人类在真实浏览器完成阿里云验证（扩展提供的 /captcha 授权页），
 *    verifyParam 通过管理 API 提交进缓存；
 *  - 并发 waitForToken 共享同一个等待（N 个并发请求不会产生 N 个提示）；
 *  - 上游拒绝（403/3007）时 invalidate。
 *
 * 本扩展刻意不包含任何自动求解/绕过/指纹伪造 —— 见 README 合规边界。
 * （zcode-api 的 happy-dom 方案作为独立技术调研存在，不属于本扩展。）
 */
import { CaptchaConfigCache, DEFAULT_CAPTCHA_CONFIG, type ZCodeCaptchaConfig } from './captcha-config.js'

export { DEFAULT_CAPTCHA_CONFIG }
export type { ZCodeCaptchaConfig }

export type CaptchaError = 'needs_manual_action' | 'expired'

export class ZCodeCaptchaUnavailableError extends Error {
  constructor(
    readonly kind: CaptchaError,
    message: string,
  ) {
    super(message)
    this.name = 'ZCodeCaptchaUnavailableError'
  }
}

export interface CaptchaManagerOptions {
  /** 提交的 verifyParam 有效期（ms），默认 45s（上游实际接受窗口） */
  cacheTtlMs?: number
  now?: () => number
  fetcher?: typeof fetch
  configUrl?: string
}

export class ZCodeCaptchaManager {
  private cachedParam: string | null = null
  private cachedAt = 0
  private pending: Promise<string> | null = null
  private resolvePending: ((value: string) => void) | null = null
  private rejectPending: ((err: Error) => void) | null = null
  private readonly configCache: CaptchaConfigCache
  private readonly cacheTtlMs: number
  private readonly now: () => number

  constructor(options: CaptchaManagerOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 45_000
    this.now = options.now ?? (() => Date.now())
    this.configCache = new CaptchaConfigCache({
      now: options.now,
      fetcher: options.fetcher,
      configUrl: options.configUrl,
    })
  }

  isValid(): boolean {
    return this.cachedParam !== null && this.now() - this.cachedAt < this.cacheTtlMs
  }

  peek(): string | null {
    return this.isValid() ? this.cachedParam : null
  }

  /** 拉取验证码配置（prefix/region/sceneId），供授权页渲染 widget。 */
  fetchConfig(): Promise<ZCodeCaptchaConfig> {
    return this.configCache.get()
  }

  /** 取缓存令牌；无有效令牌时抛 needs_manual_action —— 绝不伪造。 */
  getToken(): string {
    const cached = this.peek()
    if (cached) return cached
    throw new ZCodeCaptchaUnavailableError('needs_manual_action', 'no valid captcha token; submit one via the captcha page')
  }

  /**
   * 等待一个令牌，所有并发调用者共享同一个 Promise（单飞）。
   * submit() 到达即全部 resolve；超时统一拒绝。
   */
  waitForToken(timeoutMs: number): Promise<string> {
    const cached = this.peek()
    if (cached) return Promise.resolve(cached)
    if (this.pending) return this.pending
    this.pending = new Promise<string>((resolve, reject) => {
      this.resolvePending = resolve
      this.rejectPending = reject
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          this.failPending(new ZCodeCaptchaUnavailableError('needs_manual_action', 'captcha token was not provided in time'))
        }, timeoutMs)
        timer.unref?.()
      }
    })
    return this.pending
  }

  /** 运维者/用户从授权页提交的令牌（人类完成验证后的产物）。 */
  submit(verifyParam: string): void {
    const value = verifyParam.trim()
    if (value.length === 0) throw new Error('verifyParam must not be empty')
    this.cachedParam = value
    this.cachedAt = this.now()
    if (this.resolvePending) {
      const resolve = this.resolvePending
      this.pending = null
      this.resolvePending = null
      this.rejectPending = null
      resolve(value)
    }
  }

  /** 上游拒绝时丢弃缓存（403 挑战 / 3007）。 */
  invalidate(): void {
    this.cachedParam = null
    this.cachedAt = 0
  }

  failPending(error: Error): void {
    if (!this.rejectPending) return
    const reject = this.rejectPending
    this.pending = null
    this.resolvePending = null
    this.rejectPending = null
    reject(error)
  }
}
