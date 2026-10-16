/**
 * Phase 3 Extension Protocol error contract.
 *
 * Every failure the extension reports maps onto the Gateway's `UpstreamErrorKind`
 * vocabulary (core/errors/upstream-error.ts), plus the protocol-reserved
 * `PROTOCOL_VIOLATION`. Internal error conditions are translated here; the wire
 * body never carries provider-specific codes or credential material.
 *
 * Wire body:
 *   { error: { kind, message, httpStatus?, retryable?, retryAfterMs?,
 *              modelResetAtMs?, detail? } }
 */

/** Kinds the Gateway understands (exact enum from core/errors/upstream-error.ts). */
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

/** Extensions may additionally emit the protocol-reserved violation kind. */
export type ExtensionErrorKind = UpstreamErrorKind | 'PROTOCOL_VIOLATION'

const KNOWN_KINDS: readonly string[] = [...UPSTREAM_ERROR_KINDS, 'PROTOCOL_VIOLATION']

export function isProtocolErrorKind(kind: string): kind is ExtensionErrorKind {
  return KNOWN_KINDS.includes(kind)
}

export interface ExtensionErrorBody {
  error: {
    kind: ExtensionErrorKind
    /** human-readable, already sanitized — never contains credentials */
    message: string
    /** upstream HTTP status when the failure originated from the provider API */
    httpStatus?: number
    retryable?: boolean
    retryAfterMs?: number
    modelResetAtMs?: number
    detail?: Record<string, unknown>
  }
}

/** HTTP status per kind — mirrors Core's extension→UpstreamError expectations. */
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

export interface ProtocolErrorOptions {
  /** Upstream HTTP status, recorded as metadata (does NOT set our response status). */
  httpStatus?: number
  /** Deliberate response status for protocol-situation errors (404/409/422). */
  responseStatus?: number
  retryable?: boolean
  retryAfterMs?: number
  modelResetAtMs?: number
  detail?: Record<string, unknown>
}

/** A protocol-classified error. Messages are always credential-free. */
export class ProtocolError extends Error {
  readonly kind: ExtensionErrorKind
  readonly httpStatus?: number
  private readonly responseStatus?: number
  readonly retryable?: boolean
  readonly retryAfterMs?: number
  readonly modelResetAtMs?: number
  readonly detail?: Record<string, unknown>

  constructor(kind: ExtensionErrorKind, message?: string, opts: ProtocolErrorOptions = {}) {
    super(message ?? defaultMessage(kind))
    this.name = 'ProtocolError'
    this.kind = kind
    this.httpStatus = opts.httpStatus
    this.responseStatus = opts.responseStatus
    this.retryable = opts.retryable ?? KIND_RETRYABLE[kind]
    this.retryAfterMs = opts.retryAfterMs
    this.modelResetAtMs = opts.modelResetAtMs
    this.detail = opts.detail
  }

  status(): number {
    // `responseStatus` (an explicit protocol-situation status such as 404/422)
    // wins; otherwise the kind's canonical status. Upstream metadata
    // (`httpStatus`) never becomes our response status.
    if (this.responseStatus !== undefined) return this.responseStatus
    return KIND_STATUS[this.kind]
  }

  toBody(): ExtensionErrorBody {
    const error: ExtensionErrorBody['error'] = {
      kind: this.kind,
      message: this.message,
    }
    if (this.httpStatus !== undefined) error.httpStatus = this.httpStatus
    if (this.retryable !== undefined) error.retryable = this.retryable
    if (this.retryAfterMs !== undefined) error.retryAfterMs = this.retryAfterMs
    if (this.modelResetAtMs !== undefined) error.modelResetAtMs = this.modelResetAtMs
    if (this.detail !== undefined) error.detail = this.detail
    return { error }
  }
}

function defaultMessage(kind: ExtensionErrorKind): string {
  const messages: Record<ExtensionErrorKind, string> = {
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
  return messages[kind]
}

/** Coerce any thrown value into a ProtocolError (never leaking provider details). */
export function toProtocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ProtocolError('TRANSPORT', message)
}

export const errors = {
  authInvalid: (m?: string, o?: ProtocolErrorOptions) => new ProtocolError('AUTH_INVALID', m, o),
  tokenExpired: (m?: string, o?: ProtocolErrorOptions) => new ProtocolError('TOKEN_EXPIRED', m, o),
  rateLimit: (m?: string, o?: ProtocolErrorOptions) => new ProtocolError('RATE_LIMIT', m, o),
  quotaExhausted: (m?: string, o?: ProtocolErrorOptions) => new ProtocolError('QUOTA_EXHAUSTED', m, o),
  timeout: (m?: string, o?: ProtocolErrorOptions) => new ProtocolError('TIMEOUT', m, o),
  transport: (m?: string, o?: ProtocolErrorOptions) => new ProtocolError('TRANSPORT', m, o),
  upstream5xx: (m?: string, o?: ProtocolErrorOptions) => new ProtocolError('UPSTREAM_5XX', m, o),
  terminal: (m?: string, o?: ProtocolErrorOptions) => new ProtocolError('TERMINAL', m, o),
  emptyResponse: (m?: string, o?: ProtocolErrorOptions) => new ProtocolError('EMPTY_RESPONSE', m, o),
  needsCaptcha: (m?: string, o?: ProtocolErrorOptions) => new ProtocolError('NEEDS_CAPTCHA', m, o),
  needsManual: (m?: string, o?: ProtocolErrorOptions) => new ProtocolError('NEEDS_MANUAL', m, o),
  protocolViolation: (m?: string, o?: ProtocolErrorOptions) => new ProtocolError('PROTOCOL_VIOLATION', m, o),
} as const

/**
 * Map an upstream HTTP status to a protocol kind.
 * Provider business codes are resolved by the caller *before* this function.
 */
export function kindForUpstreamStatus(status: number): ExtensionErrorKind {
  if (status === 401 || status === 403) return 'AUTH_INVALID'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'UPSTREAM_5XX'
  if (status === 400 || status === 404 || status === 409 || status === 422) return 'TERMINAL'
  return 'TERMINAL'
}
