/**
 * LobsterAI daily check-in / balance (three-step activity protocol).
 *
 * Verified reference flow (jet-hub src/lobsterai-credits.ts):
 *   1. GET  /api/client-activities/slot?placement=…&clientVersion=…
 *   2. GET  /api/client-activities/{activityCode}/context?configRevision=…
 *   3. POST /api/client-activities/{activityCode}/actions/check_in
 * Balance: GET /api/user/profile-summary
 *
 * No captcha, no device token, no anti-bot step. The activity is only claimed
 * when the slot is available AND the context advertises a `check_in` action.
 */
import type { ClaimOutcome } from '../../core/types.js'
import {
  LOBSTERAI_ACTIVITY_CONTEXT_PATH,
  LOBSTERAI_ACTIVITY_SLOT_PATH,
  LOBSTERAI_PROFILE_SUMMARY_PATH,
  parseLobsteraiEnvelope,
  lobsteraiAuthHeaders,
  type Fetcher,
  type LobsteraiCredential,
} from './protocol.js'
import type { LobsteraiProduct } from './product.js'

/** Result of a LobsterAI credit balance probe. */
export interface LobsteraiBalance {
  known: boolean
  remaining: number | null
  total: number | null
  lastUpdatedAt: number
  /** raw payload preserved for the admin API / UI */
  rawJson: string | null
}

export interface LobsteraiActivityDeps {
  product: LobsteraiProduct
  credential: LobsteraiCredential
  clientVersion: string
  fetcher: Fetcher
}

async function request(
  deps: LobsteraiActivityDeps,
  path: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await deps.fetcher(`${deps.product.apiBase}${path}`, {
    method,
    headers: lobsteraiAuthHeaders(deps.credential, deps.product),
    ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { ok: res.ok, status: res.status, body }
}

/** Credit balance from `GET /api/user/profile-summary`. */
export async function fetchLobsteraiBalance(deps: LobsteraiActivityDeps): Promise<LobsteraiBalance> {
  const now = Date.now()
  const res = await request(deps, LOBSTERAI_PROFILE_SUMMARY_PATH)
  if (!res.ok || res.body === null) {
    return { known: false, remaining: null, total: null, lastUpdatedAt: now, rawJson: null }
  }
  const data = parseLobsteraiEnvelope(res.body).data
  const pick = (key: string): number | null =>
    typeof data[key] === 'number' ? (data[key] as number) : null
  const remaining = pick('credits') ?? pick('balance') ?? pick('remaining')
  const total = pick('totalCredits')
  return {
    known: remaining !== null,
    remaining,
    total,
    lastUpdatedAt: now,
    rawJson: JSON.stringify(data),
  }
}

interface SlotInfo {
  activityCode: string
  available: boolean
}

async function fetchActivitySlot(deps: LobsteraiActivityDeps): Promise<SlotInfo | undefined> {
  const query = new URLSearchParams({ placement: 'ide_home', clientVersion: deps.clientVersion })
  const res = await request(deps, `${LOBSTERAI_ACTIVITY_SLOT_PATH}?${query.toString()}`)
  if (!res.ok || res.body === null) return undefined
  const data = parseLobsteraiEnvelope(res.body).data
  const activityCode = typeof data.activityCode === 'string' ? data.activityCode : ''
  if (!activityCode) return undefined
  return { activityCode, available: data.slotState === 'available' }
}

/** Returns the check-in reward when the context allows it, else undefined. */
async function contextCheckInReward(
  deps: LobsteraiActivityDeps,
  activityCode: string,
): Promise<{ allowed: boolean; alreadyClaimed: boolean; credit: number }> {
  const query = new URLSearchParams({ configRevision: '1' })
  const res = await request(
    deps,
    `${LOBSTERAI_ACTIVITY_CONTEXT_PATH}/${encodeURIComponent(activityCode)}/context?${query.toString()}`,
  )
  if (!res.ok || res.body === null) return { allowed: false, alreadyClaimed: false, credit: 0 }
  const data = parseLobsteraiEnvelope(res.body).data
  const state =
    typeof data.state === 'object' && data.state !== null ? (data.state as Record<string, unknown>) : {}
  const alreadyClaimed = state.claimedToday === true
  const actions = Array.isArray(data.actions) ? data.actions : []
  const action = actions.find(
    (a) => typeof a === 'object' && a !== null && (a as Record<string, unknown>).type === 'check_in',
  ) as Record<string, unknown> | undefined
  const credit =
    action && typeof action.reward === 'number'
      ? (action.reward as number)
      : action && typeof action.credits === 'number'
        ? (action.credits as number)
        : 0
  return { allowed: action !== undefined && !alreadyClaimed, alreadyClaimed, credit }
}

/**
 * Claim today's check-in credits.
 *
 * Reads the authoritative slot/context first and only posts `check_in` when the
 * activity is available and allowed, so repeated polls never spam the endpoint.
 */
export async function claimLobsteraiCredits(deps: LobsteraiActivityDeps): Promise<ClaimOutcome> {
  const slot = await fetchActivitySlot(deps)
  if (!slot || !slot.available) {
    return { kind: 'not_available', message: 'check-in activity is not available' }
  }
  const ctx = await contextCheckInReward(deps, slot.activityCode)
  if (ctx.alreadyClaimed) {
    return { kind: 'already_claimed', message: 'today is already checked in' }
  }
  if (!ctx.allowed) {
    return { kind: 'not_available', message: 'check-in action is not offered' }
  }
  const res = await request(
    deps,
    `${LOBSTERAI_ACTIVITY_CONTEXT_PATH}/${encodeURIComponent(slot.activityCode)}/actions/check_in`,
    'POST',
  )
  const envelope = res.body === null ? undefined : parseLobsteraiEnvelope(res.body)
  if (res.ok && envelope?.ok) {
    return { kind: 'success', credit: ctx.credit, message: 'check-in claimed' }
  }
  const code = envelope?.code
  const message = envelope?.message ?? `HTTP ${res.status}`
  // Upstream repeat-claim codes are a normal idempotent result.
  if (code === 10001 || code === 1001) return { kind: 'already_claimed', message }
  if (res.status === 401 || res.status === 403) return { kind: 'needs_auth', message }
  if (res.status === 429) return { kind: 'rate_limited', message }
  return { kind: 'failed', message }
}

/** Lightweight read-only probe used by the health check. */
export async function probeLobsteraiAccount(deps: LobsteraiActivityDeps): Promise<{ ok: boolean; error?: string }> {
  const res = await request(deps, LOBSTERAI_PROFILE_SUMMARY_PATH)
  if (res.status === 401 || res.status === 403) return { ok: false, error: `HTTP ${res.status}` }
  return { ok: res.ok || res.status === 404, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) }
}
