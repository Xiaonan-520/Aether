/**
 * Shared captcha token cache for human-submitted verify params.
 *
 * A *human* completes the Aliyun verification in a real browser (admin API
 * submission or the `/api/accounts/zcode/captcha/authorize` page); the
 * resulting `verifyParam` token is cached, reused across concurrent requests
 * and invalidated when upstream rejects it.
 *
 * The Gateway deliberately does NOT automate, bypass or solve the captcha:
 * there is no headless/stealth browser here. When a token is required and
 * none is cached, callers report `needs_manual_action`.
 *
 * Reused from the community bridge: token cache + TTL, single-flight and the
 * invalidate-on-reject shape. What is NOT reused: any browser automation /
 * anti-detection.
 */
import { CaptchaConfigCache, DEFAULT_CAPTCHA_CONFIG, type ZCodeCaptchaConfig } from './captcha-config.js'

export { DEFAULT_CAPTCHA_CONFIG }
export type { ZCodeCaptchaConfig }

export type CaptchaError = 'needs_manual_action' | 'expired'

export class ZCodeCaptchaUnavailableError extends Error {
  readonly kind: CaptchaError
  constructor(kind: CaptchaError, message: string) {
    super(message)
    this.name = 'ZCodeCaptchaUnavailableError'
    this.kind = kind
  }
}

export interface CaptchaManagerOptions {
  /** how long a submitted verifyParam stays valid (ms); default 45s */
  cacheTtlMs?: number
  /** how long the fetched captcha config is cached (ms); default 60s */
  configTtlMs?: number
  /** clock injection for tests */
  now?: () => number
  fetcher?: typeof fetch
  /** config endpoint */
  configUrl?: string
}

/**
 * Single-flight captcha token cache.
 *
 * Concurrent `waitForToken()` calls share one wait: the first call parks a
 * promise and every other caller awaits the same one, so N parallel chat
 * requests never produce N captcha prompts.
 */
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
      configTtlMs: options.configTtlMs,
      now: options.now,
      fetcher: options.fetcher,
      configUrl: options.configUrl,
    })
  }

  /** Is a token currently cached and unexpired? */
  isValid(): boolean {
    return this.cachedParam !== null && this.now() - this.cachedAt < this.cacheTtlMs
  }

  /** Cached token, or null when absent/expired. */
  peek(): string | null {
    return this.isValid() ? this.cachedParam : null
  }

  /**
   * Fetch the captcha configuration (prefix/region/sceneId), cached with a
   * positive/negative window, falling back to the built-in defaults.
   */
  async fetchConfig(): Promise<ZCodeCaptchaConfig> {
    return this.configCache.get()
  }

  /**
   * Return a usable verifyParam.
   *
   * If one is cached it is returned immediately. Otherwise this throws
   * `needs_manual_action` — the Gateway never solves the captcha itself; an
   * operator submits one through `submit()`.
   */
  getToken(): string {
    const cached = this.peek()
    if (cached) return cached
    throw new ZCodeCaptchaUnavailableError('needs_manual_action', 'no valid captcha token; submit one via the admin API')
  }

  /**
   * Await a token, sharing one wait across all concurrent callers. Resolves as
   * soon as `submit()` is called (single-flight); rejects on `timeoutMs`.
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

  /** Operator-supplied token from a legitimate browser session. */
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

  /** Drop the cached token (called on a captcha 403 before retrying). */
  invalidate(): void {
    this.cachedParam = null
    this.cachedAt = 0
  }

  /** Reject a waiting single-flight promise. */
  failPending(error: Error): void {
    if (!this.rejectPending) return
    const reject = this.rejectPending
    this.pending = null
    this.resolvePending = null
    this.rejectPending = null
    reject(error)
  }

  /** Test/telemetry helper. */
  get cacheTtl(): number {
    return this.cacheTtlMs
  }
}
