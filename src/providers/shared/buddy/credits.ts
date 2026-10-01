/**
 * Buddy-family daily check-in (credit claim) protocol.
 *
 * Endpoints and semantics come from the DSH account-hub reference
 * (`src/credits.ts`), which derived them by reverse-engineering the client and
 * verifying them against real accounts, and were additionally confirmed live
 * against this deployment's own WorkBuddy account:
 *
 *   status  POST /v2/billing/meter/checkin-activity-status  body {}
 *   claim   POST /v2/billing/meter/daily-checkin            body {}
 *   balance POST /v2/billing/meter/get-user-resource        body {}
 *
 * Notes carried over from the reference (and re-confirmed live):
 * - `checkin-activity-status` is the authoritative status source;
 *   `checkin-status` returns placeholder values (`active:false`, `*_credit:0`).
 * - No device token / captcha is involved: the plain Bearer credential works.
 * - Idempotency is reported in the body: HTTP 400 + `code` 10001 (or 1001)
 *   means "already checked in today" and is a normal result, not an error.
 * - When `active` is false the activity is not running and the claim endpoint
 *   must NOT be called.
 */
import type { ClaimOutcome } from '../../../core/types.js'
import type { BuddyProduct } from './product.js'
import { credentialAuthHeaders, type BuddyCredential, type Fetcher } from './protocol.js'

export const CHECKIN_ACTIVITY_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
export const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin'
export const USER_RESOURCE_PATH = '/v2/billing/meter/get-user-resource'

/** "already checked in today" business codes (10001 primary, 1001 legacy). */
const CODE_ALREADY_CLAIMED = 10001
const CODE_ALREADY_CLAIMED_ALT = 1001
/** 1002 = no qualification, 1003 = activity ended. */
const CODE_NO_QUALIFICATION = 1002
const CODE_ACTIVITY_ENDED = 1003

const REQUEST_TIMEOUT_MS = 30_000

export interface CheckinStatus {
  /** is the check-in activity running? false ⇒ never attempt a claim */
  active: boolean
  /** authoritative "already claimed today" flag */
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  isStreakDay: boolean
  nextStreakDay: number
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return 0
}

function readBool(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  return value === true || value === 'true' || value === 1
}

export function parseCheckinStatus(body: unknown): CheckinStatus | undefined {
  const data = (typeof body === 'object' && body !== null ? (body as Record<string, unknown>).data : undefined)
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  return {
    active: readBool(record, 'active'),
    todayCheckedIn: readBool(record, 'today_checked_in'),
    streakDays: readNumber(record, 'streak_days'),
    dailyCredit: readNumber(record, 'daily_credit'),
    todayCredit: readNumber(record, 'today_credit'),
    isStreakDay: readBool(record, 'is_streak_day'),
    nextStreakDay: readNumber(record, 'next_streak_day'),
  }
}

/** POST a JSON body with the Buddy credential headers. */
async function postJson(
  product: BuddyProduct,
  path: string,
  credential: BuddyCredential,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: unknown; message?: string }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const composed = signal ? AbortSignal.any([timeout, signal]) : timeout
  let response: Response
  try {
    response = await fetcher(`${product.endpoint}${path}`, {
      method: 'POST',
      headers: { ...credentialAuthHeaders(credential, product), 'Content-Type': 'application/json' },
      body: '{}',
      signal: composed,
    })
  } catch (error) {
    return { ok: false, status: 0, body: null, message: `network error: ${String(error)}` }
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { ok: response.ok, status: response.status, body }
}

/** Read the authoritative check-in status. */
export async function fetchCheckinStatus(
  product: BuddyProduct,
  credential: BuddyCredential,
  fetcher: Fetcher = fetch,
): Promise<CheckinStatus | undefined> {
  const result = await postJson(product, CHECKIN_ACTIVITY_STATUS_PATH, credential, fetcher)
  if (!result.ok) return undefined
  return parseCheckinStatus(result.body)
}

/**
 * Claim today's check-in credit.
 *
 * Deliberately never called when the activity is inactive or already claimed:
 * the caller checks the status first. Mapping:
 *   code 0            → success
 *   code 10001 / 1001 → already_claimed (normal, not an error)
 *   code 1002 / 1003  → not_available
 *   401 / 403         → needs_auth / needs_manual_action
 *   anything else     → failed
 */
export async function claimDailyCheckin(
  product: BuddyProduct,
  credential: BuddyCredential,
  fetcher: Fetcher = fetch,
): Promise<ClaimOutcome> {
  const result = await postJson(product, DAILY_CHECKIN_PATH, credential, fetcher)

  if (result.status === 401) return { kind: 'needs_auth', message: 'zcode/buddy credential rejected (401)' }
  if (result.status === 403) return { kind: 'needs_manual_action', message: 'buddy claim forbidden (403)' }
  if (!result.ok && result.body === null) {
    return { kind: 'failed', message: result.message ?? `HTTP ${result.status}` }
  }

  const body = (typeof result.body === 'object' && result.body !== null ? result.body : {}) as Record<string, unknown>
  const code = typeof body.code === 'number' ? body.code : -1
  const message = typeof body.msg === 'string' ? body.msg : ''

  if (code === CODE_ALREADY_CLAIMED || code === CODE_ALREADY_CLAIMED_ALT) {
    return { kind: 'already_claimed', message: message || 'already checked in today' }
  }
  if (code === CODE_NO_QUALIFICATION || code === CODE_ACTIVITY_ENDED) {
    return { kind: 'not_available', message: message || 'no qualification for the current activity' }
  }
  if (code !== 0) {
    return { kind: 'failed', message: message || `claim failed (code ${code})` }
  }

  const data = body.data
  if (typeof data !== 'object' || data === null) {
    return { kind: 'failed', message: 'claim response missing data' }
  }
  const record = data as Record<string, unknown>
  const credit = readNumber(record, 'credit')
  const streakDays = readNumber(record, 'streak_days')
  const delayed = typeof record.message === 'string' ? record.message : ''
  const parts = [`+${credit} credit`]
  if (streakDays > 0) parts.push(`streak ${streakDays}d`)
  if (delayed) parts.push(delayed)
  return { kind: 'success', credit, message: parts.join(', ') }
}
