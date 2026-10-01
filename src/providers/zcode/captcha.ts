/**
 * ZCode CAPTCHA lifecycle manager.
 *
 * Modeled on the legitimate lifecycle used by the community `zcode_proxy`
 * bridge: a captcha configuration is fetched from ZCode, a *human* completes
 * the Aliyun verification in a real browser, and the resulting `verifyParam`
 * token is cached, reused across concurrent requests and invalidated on 403.
 *
 * The Gateway deliberately does NOT automate, bypass or solve the captcha:
 * there is no headless/stealth browser here. When a token is required and none
 * is cached, the adapter reports `needs_manual_action` and the operator submits
 * a token obtained from a normal browser session via the admin API.
 *
 * What is reused from zcode_proxy: token cache + TTL, single-flight, config
 * cache, invalidate-on-403 and the retry shape. What is NOT reused: any
 * browser automation / anti-detection.
 */

export interface ZCodeCaptchaConfig {
  enabled: boolean
  prefix: string
  region: string
  sceneId: string
}

const DEFAULT_CONFIG: ZCodeCaptchaConfig = {
  enabled: true,
  prefix: 'no8xfe',
  region: 'sgp',
  sceneId: '11xygtvd',
}

export interface CaptchaManagerOptions {
  /** how long a submitted verifyParam stays valid (ms); default 45s */
  cacheTtlMs?: number
  /** how long the fetched captcha config is cached (ms); default 10min */
  configTtlMs?: number
  /** clock injection for tests */
  now?: () => number
  fetcher?: typeof fetch
  /** config endpoint */
  configUrl?: string
}

export type CaptchaError = 'needs_manual_action' | 'expired'

export class ZCodeCaptchaUnavailableError extends Error {
  readonly kind: CaptchaError
  constructor(kind: CaptchaError, message: string) {
    super(message)
    this.name = 'ZCodeCaptchaUnavailableError'
    this.kind = kind
  }
}

/**
 * Single-flight captcha token cache.
 *
 * Concurrent `getToken()` calls share one wait: the first call parks a promise
 * and every other caller awaits the same one, so N parallel chat requests never
 * produce N captcha prompts.
 */
export class ZCodeCaptchaManager {
  private cachedParam: string | null = null
  private cachedAt = 0
  private pending: Promise<string> | null = null
  private resolvePending: ((value: string) => void) | null = null
  private rejectPending: ((err: Error) => void) | null = null
  private configCache: ZCodeCaptchaConfig | null = null
  private configCachedAt = 0

  private readonly cacheTtlMs: number
  private readonly configTtlMs: number
  private readonly now: () => number
  private readonly fetcher: typeof fetch
  private readonly configUrl: string

  constructor(options: CaptchaManagerOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 45_000
    this.configTtlMs = options.configTtlMs ?? 600_000
    this.now = options.now ?? (() => Date.now())
    this.fetcher = options.fetcher ?? fetch
    this.configUrl = options.configUrl
      ?? 'https://zcode.z.ai/api/v1/client/configs?app_version=3.0.0&platform=win32'
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
   * Fetch the captcha configuration (prefix/region/sceneId), cached for
   * configTtlMs, falling back to the built-in defaults.
   */
  async fetchConfig(): Promise<ZCodeCaptchaConfig> {
    if (this.configCache && this.now() - this.configCachedAt < this.configTtlMs) return this.configCache
    try {
      const response = await this.fetcher(this.configUrl)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = (await response.json()) as Record<string, unknown>
      const data = json.data as Record<string, unknown> | undefined
      const configs = data?.configs as Record<string, unknown> | undefined
      const captcha = configs?.captcha as Record<string, unknown> | undefined
      if (captcha) {
        this.configCache = {
          enabled: captcha.enabled !== false,
          prefix: typeof captcha.prefix === 'string' ? captcha.prefix : DEFAULT_CONFIG.prefix,
          region: typeof captcha.region === 'string' ? captcha.region : DEFAULT_CONFIG.region,
          sceneId: typeof captcha.sceneId === 'string' ? captcha.sceneId : DEFAULT_CONFIG.sceneId,
        }
        this.configCachedAt = this.now()
        return this.configCache
      }
    } catch {
      // fall through to defaults
    }
    return DEFAULT_CONFIG
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
