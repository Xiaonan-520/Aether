/**
 * Raccoon credits: the one-time desktop login reward and the read-only balance.
 *
 * Verified reference (jet-hub src/raccoon-credits.ts):
 *   POST /api/web/desktop/v1/login/points/grant   (idempotency = `granted`)
 *   GET  /api/web/points/v1/balance               (read-only)
 *   GET  /api/web/points/v1/bills?paging.limit=50&paging.offset=0
 *
 * The "already granted" test must look for the specific bill
 * (`biz_type === 'reward_grant'` AND `event_name === '桌面端登录奖励'`), because a
 * new-user gift is also `reward_grant` and would otherwise read as already
 * claimed. Balance alone must never be used to infer the reward.
 */
import type { ClaimOutcome, QuotaSnapshot } from '../../core/types.js'
import {
  RACCOON_BALANCE_PATH,
  RACCOON_BILLS_PATH,
  RACCOON_LOGIN_GRANT_PATH,
  type RaccoonProduct,
} from './product.js'
import { parseRaccoonEnvelope, raccoonAuthHeaders, type Fetcher, type RaccoonCredential } from './protocol.js'

const LOGIN_REWARD_EVENT = '桌面端登录奖励'

export interface RaccoonCreditsDeps {
  product: RaccoonProduct
  credential: RaccoonCredential
  fetcher: Fetcher
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/** Read-only balance. */
export async function fetchRaccoonBalance(deps: RaccoonCreditsDeps): Promise<QuotaSnapshot> {
  const now = Date.now()
  const res = await deps.fetcher(`${deps.product.apiBase}${deps.product.pointsApiPrefix}${RACCOON_BALANCE_PATH}`, {
    headers: raccoonAuthHeaders(deps.credential, deps.product),
  })
  if (!res.ok) {
    return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now, rawJson: null }
  }
  const envelope = parseRaccoonEnvelope(await res.json().catch(() => null))
  if (!envelope.ok) {
    return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now, rawJson: null }
  }
  const balance = readNumber(envelope.data, ['balance', 'points', 'available'])
  return {
    known: balance !== undefined,
    remaining: balance ?? null,
    total: readNumber(envelope.data, ['total']) ?? null,
    resetAt: null,
    lastUpdatedAt: now,
    rawJson: JSON.stringify(envelope.data),
  }
}

/** Has the desktop login reward already been recorded in the bills? */
async function loginRewardAlreadyGranted(deps: RaccoonCreditsDeps): Promise<boolean> {
  const res = await deps.fetcher(
    `${deps.product.apiBase}${deps.product.pointsApiPrefix}${RACCOON_BILLS_PATH}?paging.limit=50&paging.offset=0`,
    { headers: raccoonAuthHeaders(deps.credential, deps.product) },
  )
  if (!res.ok) return false
  const envelope = parseRaccoonEnvelope(await res.json().catch(() => null))
  if (!envelope.ok) return false
  const list = Array.isArray(envelope.data.bills)
    ? envelope.data.bills
    : Array.isArray(envelope.data.data)
      ? envelope.data.data
      : []
  return list.some((item) => {
    if (typeof item !== 'object' || item === null) return false
    const record = item as Record<string, unknown>
    return record.biz_type === 'reward_grant' && record.event_name === LOGIN_REWARD_EVENT
  })
}

/**
 * Claim the one-time desktop login reward.
 * Idempotency is `granted === true`; a repeat call returns HTTP 200 with
 * `granted: false` and is mapped to `already_claimed`.
 */
export async function claimRaccoonLoginReward(deps: RaccoonCreditsDeps): Promise<ClaimOutcome> {
  if (await loginRewardAlreadyGranted(deps)) {
    return { kind: 'already_claimed', message: 'desktop login reward already granted' }
  }
  const res = await deps.fetcher(`${deps.product.apiBase}${deps.product.desktopApiPrefix}${RACCOON_LOGIN_GRANT_PATH}`, {
    method: 'POST',
    headers: raccoonAuthHeaders(deps.credential, deps.product),
  })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { kind: 'needs_auth', message: `HTTP ${res.status}` }
    if (res.status === 429) return { kind: 'rate_limited', message: `HTTP ${res.status}` }
    return { kind: 'failed', message: `HTTP ${res.status}` }
  }
  const envelope = parseRaccoonEnvelope(await res.json().catch(() => null))
  if (!envelope.ok) return { kind: 'failed', message: `code ${envelope.code}` }
  if (envelope.data.granted !== true) {
    return { kind: 'already_claimed', message: 'login reward not granted (already claimed)' }
  }
  const credit = readNumber(envelope.data, ['points', 'amount', 'credit']) ?? 3000
  return { kind: 'success', credit, message: 'desktop login reward granted' }
}
