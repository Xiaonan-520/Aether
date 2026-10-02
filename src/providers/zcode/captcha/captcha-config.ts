/**
 * Official-widget credentials for the Aliyun captcha used by ZCode.
 *
 * The prefix/region/sceneId triple identifies which Aliyun captcha scene a
 * *human* must complete in a real browser. The config is fetched from the
 * client-configs endpoint (values the official client also receives) with a
 * positive + negative cache so a network outage never stalls the hot path.
 */
export interface ZCodeCaptchaConfig {
  enabled: boolean
  prefix: string
  region: string
  sceneId: string
}

export const DEFAULT_CAPTCHA_CONFIG: ZCodeCaptchaConfig = {
  enabled: true,
  prefix: 'no8xfe',
  region: 'sgp',
  sceneId: '11xygtvd',
}

export const CAPTCHA_CONFIG_URL =
  'https://zcode.z.ai/api/v1/client/configs?app_version=3.0.0&platform=win32'

export interface CaptchaConfigOptions {
  configTtlMs?: number
  /** negative-cache window after a failed fetch (default 15s) */
  negativeTtlMs?: number
  /** bound on the config fetch itself (default 5s) */
  fetchTimeoutMs?: number
  now?: () => number
  fetcher?: typeof fetch
  configUrl?: string
}

interface CacheState {
  value: ZCodeCaptchaConfig | null
  cachedAt: number
  negativeUntil: number
}

export class CaptchaConfigCache {
  private readonly configTtlMs: number
  private readonly negativeTtlMs: number
  private readonly fetchTimeoutMs: number
  private readonly now: () => number
  private readonly fetcher: typeof fetch
  private readonly configUrl: string
  private state: CacheState = { value: null, cachedAt: 0, negativeUntil: 0 }

  constructor(options: CaptchaConfigOptions = {}) {
    this.configTtlMs = options.configTtlMs ?? 60_000
    this.negativeTtlMs = options.negativeTtlMs ?? 15_000
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 5_000
    this.now = options.now ?? (() => Date.now())
    this.fetcher = options.fetcher ?? fetch
    this.configUrl = options.configUrl ?? CAPTCHA_CONFIG_URL
  }

  /**
   * Fetch the captcha config, cached for configTtlMs; on failure fall back to
   * the built-in defaults after a short negative cache (fail-open).
   */
  async get(): Promise<ZCodeCaptchaConfig> {
    const now = this.now()
    if (this.state.value && now - this.state.cachedAt < this.configTtlMs) return this.state.value
    if (now < this.state.negativeUntil) return DEFAULT_CAPTCHA_CONFIG
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs)
      let response: Response
      try {
        response = await this.fetcher(this.configUrl, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = (await response.json()) as Record<string, unknown>
      const data = json.data as Record<string, unknown> | undefined
      const configs = data?.configs as Record<string, unknown> | undefined
      const captcha = configs?.captcha as Record<string, unknown> | undefined
      if (!captcha) throw new Error('config payload has no captcha section')
      const config: ZCodeCaptchaConfig = {
        enabled: captcha.enabled !== false,
        prefix: typeof captcha.prefix === 'string' ? captcha.prefix : DEFAULT_CAPTCHA_CONFIG.prefix,
        region: typeof captcha.region === 'string' ? captcha.region : DEFAULT_CAPTCHA_CONFIG.region,
        sceneId: typeof captcha.sceneId === 'string' ? captcha.sceneId : DEFAULT_CAPTCHA_CONFIG.sceneId,
      }
      this.state = { value: config, cachedAt: now, negativeUntil: 0 }
      return config
    } catch {
      this.state = { value: null, cachedAt: 0, negativeUntil: now + this.negativeTtlMs }
      return DEFAULT_CAPTCHA_CONFIG
    }
  }

  invalidate(): void {
    this.state = { value: null, cachedAt: 0, negativeUntil: 0 }
  }
}

/** Params for loading the official Aliyun widget in a real browser page. */
export interface CaptchaWidgetParams {
  prefix: string
  region: string
  sceneId: string
  /** Where the widget script is served from (per-region CDN). */
  scriptUrl: string
}

const REGION_SCRIPT: Record<string, string> = {
  sgp: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',
  cn: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',
}

export function widgetParams(config: ZCodeCaptchaConfig): CaptchaWidgetParams {
  return {
    prefix: config.prefix,
    region: config.region,
    sceneId: config.sceneId,
    scriptUrl: REGION_SCRIPT[config.region] ?? REGION_SCRIPT.sgp,
  }
}
