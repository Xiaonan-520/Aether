/**
 * Protocol-level error envelope (RFC v2 §14).
 *
 * The 11 semantic kinds are SHARED with Core's internal `UpstreamErrorKind` —
 * one enum, no duplicated taxonomy. Extensions translate provider-specific
 * business codes internally and surface only these kinds; provider-specific
 * HTTP statuses never leak into the protocol.
 *
 * Protocol/transport failures (Core cannot reach the extension) map onto
 * TRANSPORT so Core's existing failover treats them like "upstream down".
 * PROTOCOL_VIOLATION (payload failed schema validation) is protocol-reserved
 * and handled as TERMINAL for the request.
 */

import { UpstreamError, type UpstreamErrorKind } from '../../core/errors/upstream-error.js'

/** Structured error body returned by an extension (HTTP non-2xx or error frame). */
export interface ExtensionErrorBody {
  error: {
    kind: UpstreamErrorKind | 'PROTOCOL_VIOLATION'
    /** human-readable, already sanitized — never contains credentials */
    message: string
    /** upstream HTTP status when the failure originated from the provider API */
    httpStatus?: number
    retryable?: boolean
    retryAfterMs?: number
    /** per-model cooldown hint (existing ModelRateLimit semantics) */
    modelResetAtMs?: number
    /** provider-agnostic structured supplement */
    detail?: Record<string, unknown>
  }
}

/** Kinds an extension is allowed to emit (everything Core's classifier knows). */
export function isProtocolErrorKind(kind: string): kind is UpstreamErrorKind | 'PROTOCOL_VIOLATION' {
  const known: readonly string[] = [
    'AUTH_INVALID', 'TOKEN_EXPIRED', 'RATE_LIMIT', 'QUOTA_EXHAUSTED',
    'TIMEOUT', 'TRANSPORT', 'UPSTREAM_5XX', 'TERMINAL', 'EMPTY_RESPONSE',
    'NEEDS_CAPTCHA', 'NEEDS_MANUAL', 'PROTOCOL_VIOLATION',
  ]
  return known.includes(kind)
}

/** Validate + normalize an extension error body into Core's UpstreamError. */
export function extensionErrorToUpstreamError(body: ExtensionErrorBody, provider: string): UpstreamError {
  const kind = body.error.kind === 'PROTOCOL_VIOLATION' ? 'TERMINAL' : body.error.kind
  return new UpstreamError({
    kind,
    message: body.error.message,
    status: body.error.httpStatus,
    provider,
    retryAfterMs: body.error.retryAfterMs,
    detail: body.error.modelResetAtMs !== undefined
      ? `model_reset_at:${body.error.modelResetAtMs}`
      : undefined,
  })
}
