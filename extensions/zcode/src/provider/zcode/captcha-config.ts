/**
 * 阿里云验证码场景配置（prefix/region/sceneId）。
 *
 * 与 Core 内置适配器同源：从 client-configs 端点拉取（官方客户端也收这些值），
 * 带 60s 正缓存 + 15s 负缓存；拉取失败回落到内置默认值（fail-open）。
 * 这些值只用于给「人类」渲染授权页 widget —— 自动化求解不在本扩展的边界内。
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
  negativeTtlMs?: number
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
        prefix: typeof captcha.prefix === 'string' && captcha.prefix.length > 0 ? captcha.prefix : DEFAULT_CAPTCHA_CONFIG.prefix,
        region: typeof captcha.region === 'string' && captcha.region.length > 0 ? captcha.region : DEFAULT_CAPTCHA_CONFIG.region,
        sceneId: typeof captcha.sceneId === 'string' && captcha.sceneId.length > 0 ? captcha.sceneId : DEFAULT_CAPTCHA_CONFIG.sceneId,
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

const REGION_SCRIPT: Record<string, string> = {
  sgp: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',
  cn: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',
}

export function widgetScriptUrl(region: string): string {
  return REGION_SCRIPT[region] ?? REGION_SCRIPT['sgp']!
}
