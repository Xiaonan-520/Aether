/**
 * Structured logger. Every log line is JSON with a ts + level + msg and zeros or
 * more structured fields. Callers must pass request_id / account_id / model_id /
 * action / duration / status / error_code as appropriate — never credentials,
 * never authorization headers, never full tokens, never full prompt bodies.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export class Logger {
  private readonly threshold: number

  constructor(level: LogLevel = 'info') {
    this.threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.threshold) return
    const record: Record<string, unknown> = { ts: new Date().toISOString(), level, msg, ...(fields ?? {}) }
    const line = JSON.stringify(record)
    if (level === 'error') process.stderr.write(line + '\n')
    else process.stdout.write(line + '\n')
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.emit('debug', msg, fields) }
  info(msg: string, fields?: Record<string, unknown>): void { this.emit('info', msg, fields) }
  warn(msg: string, fields?: Record<string, unknown>): void { this.emit('warn', msg, fields) }
  error(msg: string, fields?: Record<string, unknown>): void { this.emit('error', msg, fields) }
}

export function parseLogLevel(raw: string | undefined): LogLevel {
  const value = String(raw ?? 'info').toLowerCase()
  return (['debug', 'info', 'warn', 'error'] as const).includes(value as LogLevel)
    ? (value as LogLevel)
    : 'info'
}