/**
 * Daily check-in credit claim (upstream billing meter).
 *
 * Two-step protocol, mirroring the reference buddy adapter:
 *   1. `checkin-activity-status` is the authoritative status source — the
 *      claim endpoint is only called when the activity is running and today's
 *      credit is unclaimed.
 *   2. `daily-checkin` performs the claim; its business `code` decides the
 *      outcome. Mapping (see docs/UPSTREAM_RESEARCH.md §5):
 *        code 0            → success
 *        code 10001 / 1001 → already_claimed (normal, not an error)
 *        code 1002 / 1003  → not_available
 *        401 / 403         → needs_auth / needs_manual_action
 *        anything else     → failed
 * No branch ever reports success without an affirmative upstream `code: 0`
 * response, and unknown payloads map to `failed` — never to a success-like or
 * account-parking state.
 */
import type { UpstreamClient } from './client.js'
import { CHECKIN_ACTIVITY_STATUS_PATH, DAILY_CHECKIN_PATH } from './paths.js'

const CODE_ALREADY_CLAIMED = 10001
const CODE_ALREADY_CLAIMED_ALT = 1001
const CODE_NO_QUALIFICATION = 1002
const CODE_ACTIVITY_ENDED = 1003

/** Result of a claim attempt, in the wire shape Core's ClaimOutcome expects. */
export type ClaimOutcomeV1 =
  | { kind: 'success'; credit: number; message?: string }
  | { kind: 'already_claimed'; message?: string }
  | { kind: 'not_available'; message?: string }
  | { kind: 'needs_auth'; message?: string }
  | { kind: 'needs_manual_action'; message?: string }
  | { kind: 'failed'; message?: string }

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
  return value(record, key) === true || value(record, key) === 'true' || value(record, key) === 1
}

function value(record: Record<string, unknown>, key: string): unknown {
  return record[key]
}

/** Parse the `checkin-activity-status` payload (`data` envelope, snake_case). */
export function parseCheckinStatus(body: unknown): CheckinStatus | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const data = (body as Record<string, unknown>).data
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

/** Read the authoritative check-in status. Returns undefined on any non-200. */
export async function fetchCheckinStatus(
  client: UpstreamClient,
  credential: Parameters<UpstreamClient['postBilling']>[0],
): Promise<CheckinStatus | undefined> {
  const { status, body } = await client.postBilling(credential, CHECKIN_ACTIVITY_STATUS_PATH)
  if (status !== 200) return undefined
  return parseCheckinStatus(body)
}

/**
 * Claim today's check-in credit. Deliberately never called when the activity
 * is inactive or already claimed — the caller checks the status first.
 */
export async function claimDailyCheckin(
  client: UpstreamClient,
  credential: Parameters<UpstreamClient['postBilling']>[0],
): Promise<ClaimOutcomeV1> {
  const { status, body } = await client.postBilling(credential, DAILY_CHECKIN_PATH)

  if (status === 401) return { kind: 'needs_auth', message: 'workbuddy credential rejected (401)' }
  if (status === 403) return { kind: 'needs_manual_action', message: 'workbuddy claim forbidden (403)' }

  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const code = typeof record.code === 'number' ? record.code : -1
  const message = typeof record.message === 'string'
    ? record.message
    : (typeof record.msg === 'string' ? record.msg : '')

  if (code === CODE_ALREADY_CLAIMED || code === CODE_ALREADY_CLAIMED_ALT) {
    return { kind: 'already_claimed', message: message || 'already checked in today' }
  }
  if (code === CODE_NO_QUALIFICATION || code === CODE_ACTIVITY_ENDED) {
    return { kind: 'not_available', message: message || 'no qualification for the current activity' }
  }
  if (code !== 0) {
    return { kind: 'failed', message: message || `claim failed (code ${code})` }
  }

  const data = record.data
  if (typeof data !== 'object' || data === null) {
    return { kind: 'failed', message: 'claim response missing data' }
  }
  const payload = data as Record<string, unknown>
  const credit = readNumber(payload, 'credit')
  const streakDays = readNumber(payload, 'streak_days')
  const delayed = typeof payload.message === 'string' ? payload.message : ''
  const parts = [`+${credit} credit`]
  if (streakDays > 0) parts.push(`streak ${streakDays}d`)
  if (delayed) parts.push(delayed)
  return { kind: 'success', credit, message: parts.join(', ') }
}
