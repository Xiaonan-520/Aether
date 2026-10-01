/**
 * Normalized upstream error classifier.
 *
 * Every provider adapter maps its raw upstream errors onto these `UpstreamErrorKind`
 * values. Gateway Core (Account Pool / failover / HTTP mapping) only understands
 * these kinds — it never reads provider-specific error bodies.
 */

export type UpstreamErrorKind =
  | 'AUTH_INVALID'     // 401 / 403; try refresh once
  | 'TOKEN_EXPIRED'    // access token was already expired
  | 'RATE_LIMIT'       // 429 / queue / concurrency; cooldown + maybe switch
  | 'QUOTA_EXHAUSTED'  // balance insufficient; stop the account + switch
  | 'TIMEOUT'          // first-token or inter-chunk idle timeout; retryable
  | 'TRANSPORT'        // network / DNS / connect; retryable (fast)
  | 'UPSTREAM_5XX'     // temporary server error; limited retry
  | 'TERMINAL'         // business rejection / bad request / unsupported
  | 'EMPTY_RESPONSE'   // upstream returned nothing usable
  | 'NEEDS_CAPTCHA'    // upstream requires a captcha the gateway will not auto-solve
  | 'NEEDS_MANUAL'     // human action required (sms, captcha, re-login, unclaimable)

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind
  readonly status?: number
  readonly provider?: string
  readonly retryAfterMs?: number
  /** machine-safe detail (no secrets) */
  readonly detail?: string

  constructor(opts: {
    kind: UpstreamErrorKind
    message: string
    status?: number
    provider?: string
    retryAfterMs?: number
    detail?: string
    cause?: unknown
  }) {
    super(opts.message)
    this.name = 'UpstreamError'
    this.kind = opts.kind
    this.status = opts.status
    this.provider = opts.provider
    this.retryAfterMs = opts.retryAfterMs
    this.detail = opts.detail
    if (opts.cause !== undefined) this.cause = opts.cause
  }

  get isTerminal(): boolean {
    return this.kind === 'TERMINAL'
      || this.kind === 'NEEDS_CAPTCHA'
      || this.kind === 'NEEDS_MANUAL'
  }

  get isRetryable(): boolean {
    return this.kind === 'TIMEOUT'
      || this.kind === 'TRANSPORT'
      || this.kind === 'UPSTREAM_5XX'
  }

  get isAuthProblem(): boolean {
    return this.kind === 'AUTH_INVALID' || this.kind === 'TOKEN_EXPIRED'
  }

  get isQuotaProblem(): boolean {
    return this.kind === 'QUOTA_EXHAUSTED'
  }
}

/** Build a retry/backoff budget used by the pool (not "blind retry"). */
export function retryDelayMs(kind: UpstreamErrorKind, attempt: number): number {
  // conservative exponential backoff: 1s,2s,4s,8s… capped
  const base = kind === 'TRANSPORT' ? 500 : 1000
  return Math.min(base * 2 ** Math.max(0, attempt - 1), 30_000)
}
