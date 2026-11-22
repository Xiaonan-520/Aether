/**
 * Manual-claim ("weekend plan") support.
 *
 * Ported from TriDefender/zcode-api (`src/claim/types.ts`, CC BY-NC-SA 4.0 —
 * see THIRD-PARTY-NOTICES.md). The claim plane is what turns a trial/weekend
 * campaign into a usable entitlement: the account's JWT alone is not enough
 * until the plan is claimed, and campaigns are first-come-first-served, which
 * is why the reference implementation polls and claims automatically.
 *
 * Server biz codes → failure kinds mirror the desktop client's mapper.
 */

/** One entitlement inside a claimable plan (normalized from snake_case). */
export interface PlanEntitlement {
  entitlementId: string
  showName: string
  meter: string
  unitType: string
  capabilities: string[]
  grantUnits: number
  period: string
  priority: number
  /** Unix seconds when the entitlement activates (weekend plans activate late). */
  effectiveAt?: number
}

/** A claimable trial plan from the billing preview or the marketing banner. */
export interface ClaimablePlan {
  planId: string
  name: string
  description: string
  priority: number
  entitlements: PlanEntitlement[]
  startsAt?: number
  endsAt?: number
  /** Enumeration face that surfaced the plan (billing preview vs banner). */
  source?: 'preview' | 'banner'
  /** Marketing campaign id (banner-sourced plans only). */
  campaignId?: string
}

export type ClaimFailureKind =
  | 'not_found'
  | 'unavailable'
  | 'already_claimed'
  | 'ineligible'
  | 'quota_exhausted'
  | 'invalid_request'
  | 'captcha'
  | 'login_required'
  | 'http_error'
  | 'unknown'

export type ClaimOutcome =
  | { ok: true; planId: string; startsAt?: number; endsAt?: number }
  | {
      ok: false
      planId: string
      failureKind: ClaimFailureKind
      code: number | string
      message: string
      failureEndsAt?: number
    }

/** Map a server biz code to the client failure kind (mirrors `$vt`). */
export function classifyClaimCode(code: number | string | undefined): ClaimFailureKind {
  switch (typeof code === 'string' ? Number.parseInt(code, 10) : code) {
    case 1001: return 'not_found'
    case 1002: return 'unavailable'
    case 1003: return 'already_claimed'
    case 1004: return 'ineligible'
    case 1005: return 'quota_exhausted'
    case 3001: return 'invalid_request'
    case 3007: return 'captcha'
    case 401: return 'login_required'
    default: return 'unknown'
  }
}

/** Operator-facing labels (reference `FAILURE_LABELS`). */
export const CLAIM_FAILURE_LABELS: Readonly<Record<ClaimFailureKind, string>> = {
  not_found: 'plan does not exist',
  unavailable: 'campaign ended or not claimable yet',
  already_claimed: 'already claimed on this account',
  ineligible: 'account or client version not eligible',
  quota_exhausted: 'daily claim quota exhausted',
  invalid_request: 'invalid request',
  captcha: 'captcha verification failed',
  login_required: 'not logged in',
  http_error: 'claim endpoint returned an HTTP error',
  unknown: 'unknown claim failure',
}

/**
 * Preview failure with the HTTP status preserved. `status === 404` means the
 * campaign endpoint is not deployed yet — the expected pre-launch state.
 */
export class ClaimPreviewError extends Error {
  readonly status: number
  readonly code: number | string

  constructor(message: string, status: number, code: number | string) {
    super(message)
    this.name = 'ClaimPreviewError'
    this.status = status
    this.code = code
  }
}
