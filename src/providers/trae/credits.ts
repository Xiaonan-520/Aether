/**
 * TRAE check-in credits and quota.
 *
 * Verified reference paths (jet-hub src/trae-credits.ts):
 *   status  POST /trae/api/v2/ug/checkin_credits/status   body {}
 *   claim   POST /trae/api/v2/ug/checkin_credits/claim    body {}
 *   quota   POST /trae/api/v2/pay/ide_user_ent_usage      body {"require_usage":true,"req_source":2}
 *
 * `require_usage: true` is mandatory: without it the upstream omits the usage
 * detail and `credits_amount` defaults to 0, making the balance look like the
 * full entitlement. Status is read first; the claim is only posted when the
 * status says it is claimable, so 30-minute polling never spams the endpoint.
 */
import type { ClaimOutcome, QuotaSnapshot } from '../../core/types.js'
import { traeCheckinHeaders, type Fetcher, type TraeCredential } from './protocol.js'
import {
  TRAE_CHECKIN_CLAIM_PATH,
  TRAE_CHECKIN_STATUS_PATH,
  TRAE_ENT_USAGE_PATH,
  type TraeProduct,
} from './product.js'

export interface TraeCreditsDeps {
  product: TraeProduct
  credential: TraeCredential
  uid: string
  fetcher: Fetcher
}

async function post(
  deps: TraeCreditsDeps,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await deps.fetcher(`${deps.product.ugHost}${path}`, {
    method: 'POST',
    headers: traeCheckinHeaders(deps.credential, deps.product, deps.uid),
    body: JSON.stringify(body),
  })
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  return { ok: res.ok, status: res.status, body: parsed }
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/** Business code from an enveloped response (`{code}` / `{data:{code}}`). */
function readCode(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const direct = record.code
  if (typeof direct === 'number') return direct
  const data = record.data
  if (typeof data === 'object' && data !== null) {
    const inner = (data as Record<string, unknown>).code
    if (typeof inner === 'number') return inner
  }
  return undefined
}

function dataOf(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {}
  const record = body as Record<string, unknown>
  const data = record.data
  if (typeof data === 'object' && data !== null) return data as Record<string, unknown>
  return record
}

export interface TraeCheckinStatus {
  /** whether the activity is currently claimable */
  enabled: boolean
  checkedIn: boolean
  credits?: number
}

/** Read the check-in status (authoritative). */
export async function fetchTraeCheckinStatus(deps: TraeCreditsDeps): Promise<TraeCheckinStatus | undefined> {
  const res = await post(deps, TRAE_CHECKIN_STATUS_PATH, {})
  if (!res.ok) return undefined
  const data = dataOf(res.body)
  const enabled = data.enable === true || data.enabled === true
  const checkedIn = data.checked_in === true || data.checkedIn === true
  const credits = pickNumber(data, ['credits', 'credit'])
  return { enabled, checkedIn, ...(credits !== undefined ? { credits } : {}) }
}

/**
 * Claim the daily check-in. Reads the status first and only claims when the
 * activity is enabled and today's credit is still unclaimed.
 */
export async function claimTraeCredits(deps: TraeCreditsDeps): Promise<ClaimOutcome> {
  const status = await fetchTraeCheckinStatus(deps)
  if (!status) return { kind: 'failed', message: 'could not read TRAE check-in status' }
  if (!status.enabled) return { kind: 'not_available', message: 'TRAE check-in is not enabled' }
  if (status.checkedIn) return { kind: 'already_claimed', message: 'already checked in today' }
  const res = await post(deps, TRAE_CHECKIN_CLAIM_PATH, {})
  if (res.ok) {
    const code = readCode(res.body)
    if (code === undefined || code === 0) {
      return { kind: 'success', credit: status.credits ?? 0, message: 'check-in claimed' }
    }
    // upstream "already claimed" codes are a normal idempotent result
    if (code === 10001 || code === 1001 || code === 9074) {
      return { kind: 'already_claimed', message: `code ${code}` }
    }
    return { kind: 'failed', message: `code ${code}` }
  }
  if (res.status === 401 || res.status === 403) return { kind: 'needs_auth', message: `HTTP ${res.status}` }
  if (res.status === 429) return { kind: 'rate_limited', message: `HTTP ${res.status}` }
  return { kind: 'failed', message: `HTTP ${res.status}` }
}

/** Quota / entitlement usage. `require_usage: true` is mandatory. */
export async function fetchTraeQuota(deps: TraeCreditsDeps): Promise<QuotaSnapshot> {
  const now = Date.now()
  const res = await post(deps, TRAE_ENT_USAGE_PATH, { require_usage: true, req_source: 2 })
  if (!res.ok) {
    return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now, rawJson: null }
  }
  const data = dataOf(res.body)
  const usage = typeof data.usage === 'object' && data.usage !== null ? (data.usage as Record<string, unknown>) : data
  const total = pickNumber(usage, ['credits_amount', 'total_credits', 'total'])
  const used = pickNumber(usage, ['credits_used', 'used'])
  const remaining = used !== undefined && total !== undefined ? total - used : pickNumber(usage, ['credits_remaining', 'remaining'])
  const raw = JSON.stringify(usage)
  return {
    known: remaining !== null || total !== undefined,
    remaining: remaining ?? null,
    total: total ?? null,
    resetAt: null,
    lastUpdatedAt: now,
    rawJson: raw,
  }
}
