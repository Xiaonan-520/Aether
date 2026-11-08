/** 配置：全部来自环境变量（Manager 注入 / docker-compose）。 */
import { parseLogLevel, type LogLevel } from './logger.js'

export interface AppConfig {
  port: number
  host: string
  /** Manager 注入的共享 Bearer；本地开发回退 EXTENSION_AUTH_TOKEN */
  authToken: string | undefined
  extensionId: string | undefined
  dataDir: string
  logLevel: LogLevel
  /** zcode.z.ai API base（测试指向 fake upstream） */
  upstreamApiBase: string
  /** 上游请求超时（Anthropic messages） */
  requestTimeoutMs: number
  /** 登录 init/poll 超时 */
  stateRequestTimeoutMs: number
  /** 人工验证码等待窗口上限（chat 被挑战时 waitForToken 的预算上限） */
  captchaWaitMs: number
  /** captcha 模式：manual（默认，人工交接）/ auto（happy-dom 求解，合规风险自担）/ off */
  captchaMode: 'manual' | 'auto' | 'off'
  /** auto 模式参数（缺省用内置默认值） */
  captchaSceneId: string | undefined
  captchaRegion: string | undefined
  captchaPrefix: string | undefined
  captchaPoolMin: number
  captchaPoolMax: number
  captchaSolveConcurrency: number
  captchaSolveTimeoutMs: number
  captchaCpuLimitPercent: number
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function parseCaptchaMode(raw: string | undefined): 'manual' | 'auto' | 'off' {
  const value = String(raw ?? 'manual').toLowerCase()
  return value === 'auto' ? 'auto' : value === 'off' ? 'off' : 'manual'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: intEnv('PORT', 8080),
    host: env.HOST ?? '0.0.0.0',
    authToken: env.GATEWAY_EXTENSION_TOKEN ?? (env.EXTENSION_AUTH_TOKEN === '' ? undefined : env.EXTENSION_AUTH_TOKEN),
    extensionId: env.GATEWAY_EXTENSION_ID,
    dataDir: env.DATA_DIR ?? '/data',
    logLevel: parseLogLevel(env.LOG_LEVEL),
    upstreamApiBase: env.ZCODE_API_BASE ?? 'https://zcode.z.ai/api/v1',
    requestTimeoutMs: intEnv('ZCODE_REQUEST_TIMEOUT_MS', 120_000),
    stateRequestTimeoutMs: intEnv('ZCODE_STATE_REQUEST_TIMEOUT_MS', 15_000),
    captchaWaitMs: intEnv('ZCODE_CAPTCHA_WAIT_MS', 60_000),
    captchaMode: parseCaptchaMode(env.ZCODE_CAPTCHA_MODE),
    captchaSceneId: env.ZCODE_CAPTCHA_SCENE_ID,
    captchaRegion: env.ZCODE_CAPTCHA_REGION,
    captchaPrefix: env.ZCODE_CAPTCHA_PREFIX,
    captchaPoolMin: intEnv('ZCODE_CAPTCHA_POOL_MIN', 5),
    captchaPoolMax: intEnv('ZCODE_CAPTCHA_POOL_MAX', 20),
    captchaSolveConcurrency: intEnv('ZCODE_CAPTCHA_SOLVE_CONCURRENCY', 2),
    captchaSolveTimeoutMs: intEnv('ZCODE_CAPTCHA_SOLVE_TIMEOUT_MS', 30_000),
    captchaCpuLimitPercent: intEnv('ZCODE_CAPTCHA_CPU_LIMIT_PCT', 70),
  }
}
