/**
 * Extension SDK — protocol error contract (mirror of the extensions'
 * errors.ts, self-contained). Every failure an extension reports maps onto
 * the Gateway's UpstreamErrorKind vocabulary plus the protocol-reserved
 * PROTOCOL_VIOLATION. Wire body:
 *   { error: { kind, message, httpStatus?, retryable?, retryAfterMs?,
 *              modelResetAtMs?, detail? } }
 */

export const UPSTREAM_ERROR_KINDS = [
  'AUTH_INVALID',
  'TOKEN_EXPIRED',
  'RATE_LIMIT',
  'QUOTA_EXHAUSTED',
  'TIMEOUT',
  'TRANSPORT',
  'UPSTREAM_5XX',
  'TERMINAL',
  'EMPTY_RESPONSE',
  'NEEDS_CAPTCHA',
  'NEEDS_MANUAL',
] as const

export type UpstreamErrorKind = (typeof UPSTREAM_ERROR_KINDS)[number]
export type ExtensionErrorKind = UpstreamErrorKind | 'PROTOCOL_VIOLATION'

const KNOWN_KINDS: readonly string[] = [...UPSTREAM_ERROR_KINDS, 'PROTOCOL_VIOLATION']

export function isExtensionErrorKind(kind: string): kind is ExtensionErrorKind {
  return KNOWN_KINDS.includes(kind)
}

export interface ExtensionErrorBody {
  error: {
    kind: ExtensionErrorKind
    /** human-readable, already sanitized — never contains credentials */
    message: string
    httpStatus?: number
    retryable?: boolean
    retryAfterMs?: number
    modelResetAtMs?: number
    detail?: Record<string, unknown>
  }
}

const KIND_STATUS: Record<ExtensionErrorKind, number> = {
  AUTH_INVALID: 502,
  TOKEN_EXPIRED: 502,
  RATE_LIMIT: 429,
  QUOTA_EXHAUSTED: 429,
  TIMEOUT: 504,
  TRANSPORT: 502,
  UPSTREAM_5XX: 502,
  TERMINAL: 400,
  EMPTY_RESPONSE: 502,
  NEEDS_CAPTCHA: 409,
  NEEDS_MANUAL: 409,
  PROTOCOL_VIOLATION: 400,
}

const KIND_RETRYABLE: Record<ExtensionErrorKind, boolean> = {
  AUTH_INVALID: false,
  TOKEN_EXPIRED: false,
  RATE_LIMIT: true,
  QUOTA_EXHAUSTED: false,
  TIMEOUT: true,
  TRANSPORT: true,
  UPSTREAM_5XX: true,
  TERMINAL: false,
  EMPTY_RESPONSE: false,
  NEEDS_CAPTCHA: false,
  NEEDS_MANUAL: false,
  PROTOCOL_VIOLATION: false,
}

const KIND_MESSAGE: Record<ExtensionErrorKind, string> = {
  AUTH_INVALID: 'authentication rejected by upstream',
  TOKEN_EXPIRED: 'credential expired',
  RATE_LIMIT: 'upstream rate limit reached',
  QUOTA_EXHAUSTED: 'quota exhausted',
  TIMEOUT: 'upstream request timed out',
  TRANSPORT: 'upstream unreachable',
  UPSTREAM_5XX: 'upstream server error',
  TERMINAL: 'request rejected',
  EMPTY_RESPONSE: 'upstream returned an empty response',
  NEEDS_CAPTCHA: 'upstream requires a captcha',
  NEEDS_MANUAL: 'human action required',
  PROTOCOL_VIOLATION: 'protocol contract violated',
}

export interface ExtensionErrorOptions {
  /** override the kind's canonical HTTP status (e.g. 404 unknown account) */
  responseStatus?: number
  httpStatus?: number
  retryAfterMs?: number
  modelResetAtMs?: number
  detail?: Record<string, unknown>
  cause?: unknown
}

export class ExtensionProtocolError extends Error {
  readonly kind: ExtensionErrorKind
  readonly responseStatus?: number
  readonly httpStatus?: number
  readonly retryAfterMs?: number
  readonly modelResetAtMs?: number
  readonly detail?: Record<string, unknown>

  constructor(kind: ExtensionErrorKind, message?: string, opts: ExtensionErrorOptions = {}) {
    super(message ?? KIND_MESSAGE[kind])
    this.name = 'ExtensionProtocolError'
    this.kind = kind
    this.responseStatus = opts.responseStatus
    this.httpStatus = opts.httpStatus
    this.retryAfterMs = opts.retryAfterMs
    this.modelResetAtMs = opts.modelResetAtMs
    this.detail = opts.detail
  }

  status(): number {
    return this.responseStatus ?? KIND_STATUS[this.kind]
  }

  retryable(): boolean {
    return KIND_RETRYABLE[this.kind]
  }

  toBody(): ExtensionErrorBody {
    const error: ExtensionErrorBody['error'] = { kind: this.kind, message: this.message }
    if (this.httpStatus !== undefined) error.httpStatus = this.httpStatus
    if (this.retryable()) error.retryable = true
    if (this.retryAfterMs !== undefined) error.retryAfterMs = this.retryAfterMs
    if (this.modelResetAtMs !== undefined) error.modelResetAtMs = this.modelResetAtMs
    if (this.detail !== undefined) error.detail = this.detail
    return { error }
  }
}

export function toExtensionError(error: unknown): ExtensionProtocolError {
  if (error instanceof ExtensionProtocolError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ExtensionProtocolError('TRANSPORT', message)
}

export function isExtensionErrorBody(value: unknown): value is ExtensionErrorBody {
  return (
    typeof value === 'object' && value !== null && 'error' in value &&
    typeof (value as { error?: { kind?: unknown } }).error?.kind === 'string'
  )
}

/** Map an upstream HTTP status to a protocol kind (business codes resolved first by the caller). */
export function kindForUpstreamStatus(status: number): ExtensionErrorKind {
  if (status === 401 || status === 403) return 'AUTH_INVALID'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'UPSTREAM_5XX'
  return 'TERMINAL'
}

export const errors = {
  authInvalid: (m?: string, o?: ExtensionErrorOptions) => new ExtensionProtocolError('AUTH_INVALID', m, o),
  tokenExpired: (m?: string, o?: ExtensionErrorOptions) => new ExtensionProtocolError('TOKEN_EXPIRED', m, o),
  rateLimit: (m?: string, o?: ExtensionErrorOptions) => new ExtensionProtocolError('RATE_LIMIT', m, o),
  quotaExhausted: (m?: string, o?: ExtensionErrorOptions) => new ExtensionProtocolError('QUOTA_EXHAUSTED', m, o),
  timeout: (m?: string, o?: ExtensionErrorOptions) => new ExtensionProtocolError('TIMEOUT', m, o),
  transport: (m?: string, o?: ExtensionErrorOptions) => new ExtensionProtocolError('TRANSPORT', m, o),
  upstream5xx: (m?: string, o?: ExtensionErrorOptions) => new ExtensionProtocolError('UPSTREAM_5XX', m, o),
  terminal: (m?: string, o?: ExtensionErrorOptions) => new ExtensionProtocolError('TERMINAL', m, o),
  emptyResponse: (m?: string, o?: ExtensionErrorOptions) => new ExtensionProtocolError('EMPTY_RESPONSE', m, o),
  needsCaptcha: (m?: string, o?: ExtensionErrorOptions) => new ExtensionProtocolError('NEEDS_CAPTCHA', m, o),
  needsManual: (m?: string, o?: ExtensionErrorOptions) => new ExtensionProtocolError('NEEDS_MANUAL', m, o),
  protocolViolation: (m?: string, o?: ExtensionErrorOptions) => new ExtensionProtocolError('PROTOCOL_VIOLATION', m, o),
} as const

// ---------------------------------------------------------------------------
// log sanitization
// ---------------------------------------------------------------------------

/** Keys whose values never belong in a log line. */
const REDACT_KEYS = new Set([
  'access_token', 'refresh_token', 'password', 'api_key', 'apikey', 'secret',
  'token', 'authorization', 'cookie', 'credential', 'credentials',
])

/**
 * Strip credential-shaped fields from structured-log payloads. Values are
 * replaced (not removed) so field presence stays debuggable.
 */
export function sanitizeLogFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '[redacted]' : value
  }
  return out
}
