/** Configuration, sourced from environment variables. */
import { parseLogLevel, type LogLevel } from './logger.js'

export interface AppConfig {
  port: number
  host: string
  /**
   * Shared bearer token the Gateway presents (Manager-injected `GATEWAY_EXTENSION_TOKEN`).
   * Falls back to EXTENSION_AUTH_TOKEN for local dev. Distinct from any Tencent token.
   */
  authToken: string | undefined
  /** Manager-injected extension id (`GATEWAY_EXTENSION_ID`). */
  extensionId: string | undefined
  dataDir: string
  logLevel: LogLevel
  /** Upstream WorkBuddy endpoint (Tencent CodeBuddy China). Overridable for tests. */
  upstreamEndpoint: string
  upstreamDomain: string
  productCode: string
  userAgent: string
  requestTimeoutMs: number
  stateRequestTimeoutMs: number
  streamFirstTokenTimeoutMs: number
  streamChunkIdleTimeoutMs: number
  /** TTL for a pending login session (seconds), matching upstream 5-minute polling. */
  loginTtlSeconds: number
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    // Manifest runtime.port is 8080; default the process to match.
    port: intEnv('PORT', 8080),
    host: env.HOST ?? '0.0.0.0',
    // Manager injects GATEWAY_EXTENSION_TOKEN; EXTENSION_AUTH_TOKEN is the local/dev fallback.
    authToken: env.GATEWAY_EXTENSION_TOKEN ?? (env.EXTENSION_AUTH_TOKEN === '' ? undefined : env.EXTENSION_AUTH_TOKEN),
    extensionId: env.GATEWAY_EXTENSION_ID,
    // Manager mounts the declared named volume at /data.
    dataDir: env.DATA_DIR ?? '/data',
    logLevel: parseLogLevel(env.LOG_LEVEL),
    upstreamEndpoint: env.WORKBUDDY_ENDPOINT ?? 'https://www.workbuddy.ai',
    upstreamDomain: env.WORKBUDDY_DOMAIN ?? 'www.workbuddy.ai',
    productCode: env.WORKBUDDY_PRODUCT_CODE ?? 'workbuddy',
    userAgent: env.WORKBUDDY_USER_AGENT ?? 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
    requestTimeoutMs: intEnv('WORKBUDDY_REQUEST_TIMEOUT_MS', 60_000),
    stateRequestTimeoutMs: intEnv('WORKBUDDY_STATE_REQUEST_TIMEOUT_MS', 10_000),
    streamFirstTokenTimeoutMs: intEnv('WORKBUDDY_STREAM_FIRST_TOKEN_TIMEOUT_MS', 90_000),
    streamChunkIdleTimeoutMs: intEnv('WORKBUDDY_STREAM_CHUNK_IDLE_TIMEOUT_MS', 90_000),
    loginTtlSeconds: intEnv('WORKBUDDY_LOGIN_TTL_SECONDS', 300),
  }
}
