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
  /** Upstream WorkBuddyCN endpoint (Tencent CodeBuddy China). Overridable for tests. */
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
    upstreamEndpoint: env.WORKBUDDYCN_ENDPOINT ?? 'https://copilot.tencent.com',
    upstreamDomain: env.WORKBUDDYCN_DOMAIN ?? 'copilot.tencent.com',
    productCode: env.WORKBUDDYCN_PRODUCT_CODE ?? 'codebuddy',
    userAgent: env.WORKBUDDYCN_USER_AGENT ?? 'CodeBuddyIDE/1.106.1',
    requestTimeoutMs: intEnv('WORKBUDDYCN_REQUEST_TIMEOUT_MS', 60_000),
    stateRequestTimeoutMs: intEnv('WORKBUDDYCN_STATE_REQUEST_TIMEOUT_MS', 10_000),
    streamFirstTokenTimeoutMs: intEnv('WORKBUDDYCN_STREAM_FIRST_TOKEN_TIMEOUT_MS', 90_000),
    streamChunkIdleTimeoutMs: intEnv('WORKBUDDYCN_STREAM_CHUNK_IDLE_TIMEOUT_MS', 90_000),
    loginTtlSeconds: intEnv('WORKBUDDYCN_LOGIN_TTL_SECONDS', 300),
  }
}
