/**
 * Configuration loading.
 *
 * Reads environment variables (optionally from a `.env` file) and validates
 * them with zod. All other layers receive an immutable `GatewayConfig`; nothing
 * else reads process.env directly.
 */
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'

const envSchema = z.object({
  DATA_DIR: z.string().default('./data'),
  GATEWAY_API_KEY: z.string().min(1, 'GATEWAY_API_KEY is required'),
  GATEWAY_SECRET: z
    .string()
    .min(16, 'GATEWAY_SECRET must be at least 16 characters'),
  GATEWAY_ADMIN_TOKEN: z.string().min(1, 'GATEWAY_ADMIN_TOKEN is required'),
  TZ: z.string().default('Asia/Shanghai'),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),
  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
})

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface GatewayConfig {
  dataDir: string
  gatewayApiKey: string
  gatewaySecret: string
  gatewayAdminToken: string
  tz: string
  logLevel: LogLevel
  httpHost: string
  httpPort: number
}

/** Minimal KEY=VALUE .env parser (no external dependency). Ignores comments. */
function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  // A `.env` file in the project root fills in variables not already set in
  // the real environment (real environment wins, like docker --env-file).
  if (existsSync('.env')) {
    const fileVars = parseDotEnv(readFileSync('.env', 'utf8'))
    env = { ...fileVars, ...env }
  }

  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`invalid gateway configuration: ${issues}`)
  }
  const v = parsed.data
  return {
    dataDir: v.DATA_DIR,
    gatewayApiKey: v.GATEWAY_API_KEY,
    gatewaySecret: v.GATEWAY_SECRET,
    gatewayAdminToken: v.GATEWAY_ADMIN_TOKEN,
    tz: v.TZ,
    logLevel: v.LOG_LEVEL,
    httpHost: v.HTTP_HOST,
    httpPort: v.HTTP_PORT,
  }
}
