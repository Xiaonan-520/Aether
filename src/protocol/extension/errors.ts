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
    kind: UpstreamErrorKind | 'PROTOCOL_VIOLATION' | 'EXTENSION_AUTH'
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

/**
 * `EXTENSION_AUTH` is deliberately NOT an `UpstreamErrorKind`.
 *
 * It describes a failure of the Core↔Extension hop itself (the extension's
 * `GATEWAY_EXTENSION_TOKEN` does not match the one Core holds), which happens
 * after a token rotation. That is an infrastructure problem, not a provider
 * account problem: it must never be folded into `AUTH_INVALID`, because Core's
 * account pool treats `AUTH_INVALID` as "this account's credential is dead"
 * and parks it in `token_expired`.
 */
export type ExtensionErrorKind = UpstreamErrorKind | 'PROTOCOL_VIOLATION' | 'EXTENSION_AUTH'

/** Kinds an extension is allowed to emit (Core's classifier plus EXTENSION_AUTH). */
export function isProtocolErrorKind(kind: string): kind is ExtensionErrorKind {
  const known: readonly string[] = [
    'AUTH_INVALID', 'TOKEN_EXPIRED', 'RATE_LIMIT', 'QUOTA_EXHAUSTED',
    'TIMEOUT', 'TRANSPORT', 'UPSTREAM_5XX', 'TERMINAL', 'EMPTY_RESPONSE',
    'NEEDS_CAPTCHA', 'NEEDS_MANUAL', 'PROTOCOL_VIOLATION',
    // the Core↔Extension hop, not the provider account
    'EXTENSION_AUTH',
  ]
  return known.includes(kind)
}

/**
 * True when the failure is about the Core↔Extension credential rather than the
 * provider account behind it. Callers use this to avoid parking accounts and to
 * trigger a bounded re-registration instead.
 */
export function isExtensionAuthFailure(body: ExtensionErrorBody): boolean {
  return body.error.kind === 'EXTENSION_AUTH'
}

/** Validate + normalize an extension error body into Core's UpstreamError. */
export function extensionErrorToUpstreamError(body: ExtensionErrorBody, provider: string): UpstreamError {
  // EXTENSION_AUTH is an infrastructure failure: surface it as TRANSPORT so the
  // existing failover path handles it without touching account credentials.
  // The original kind is preserved in `detail` for diagnosis/audit.
  const kind: UpstreamErrorKind = body.error.kind === 'PROTOCOL_VIOLATION'
    ? 'TERMINAL'
    : body.error.kind === 'EXTENSION_AUTH'
      ? 'TRANSPORT'
      : body.error.kind
  return new UpstreamError({
    kind,
    message: body.error.message,
    status: body.error.httpStatus,
    provider,
    retryAfterMs: body.error.retryAfterMs,
    detail: body.error.kind === 'EXTENSION_AUTH'
      ? 'extension_auth'
      : body.error.modelResetAtMs !== undefined
        ? `model_reset_at:${body.error.modelResetAtMs}`
        : undefined,
  })
}
