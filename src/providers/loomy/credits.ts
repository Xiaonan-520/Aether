/**
 * Loomy credits.
 *
 * `POST /points/first-login` triggers the **daily quota reset** (its semantics
 * are "reset today's allowance", not "+N permanent points"). Idempotency is
 * signalled by `alreadyProcessed === true` (repeat calls still return HTTP 200),
 * which is mapped to `already_claimed` rather than `success` so the caller is
 * never told points were added twice.
 *
 * `GET /points/records` is read-only and is used for the balance (calling the
 * write endpoint on a read path would accidentally claim).
 */
import type { ClaimOutcome, QuotaSnapshot } from '../../core/types.js'
import {
  LOOMY_FIRST_LOGIN_PATH,
  LOOMY_POINTS_RECORDS_PATH,
  type LoomyProduct,
} from './product.js'
import { isLoomyExpired, loomyBusinessHeaders, parseLoomyEnvelope, type Fetcher, type LoomyCredential } from './protocol.js'

export interface LoomyCreditsDeps {
  product: LoomyProduct
  credential: LoomyCredential
  fetcher: Fetcher
}

export interface LoomyCreditDetail {
  permanent: number
  daily: number
  total: number
  dailyQuota?: number
  dailyConsumed?: number
}

function readNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Read-only balance from `/points/records`. Returns undefined when unreadable. */
export async function fetchLoomyCreditDetail(deps: LoomyCreditsDeps): Promise<LoomyCreditDetail | undefined> {
  const res = await deps.fetcher(
    `${deps.product.apiBase}${LOOMY_POINTS_RECORDS_PATH}?pageNo=1&pageSize=1&recordType=all`,
    { headers: loomyBusinessHeaders(deps.credential.access_token) },
  )
  if (!res.ok) return undefined
  const envelope = parseLoomyEnvelope(await res.json().catch(() => null))
  if (!envelope.ok) return undefined
  const permanent = readNumber(envelope.data.balance)
  if (permanent === undefined) return undefined
  const daily = readNumber(envelope.data.dailyBalance) ?? 0
  const available = readNumber(envelope.data.availableBalance)
  return {
    permanent,
    daily,
    total: available ?? permanent + daily,
    ...(readNumber(envelope.data.dailyQuota) !== undefined ? { dailyQuota: readNumber(envelope.data.dailyQuota)! } : {}),
    ...(readNumber(envelope.data.dailyConsumed) !== undefined ? { dailyConsumed: readNumber(envelope.data.dailyConsumed)! } : {}),
  }
}

/** Quota view over the credit detail (Loomy has no separate quota API). */
export async function fetchLoomyQuota(deps: LoomyCreditsDeps): Promise<QuotaSnapshot> {
  const now = Date.now()
  const detail = await fetchLoomyCreditDetail(deps)
  if (!detail) {
    return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now, rawJson: null }
  }
  return {
    known: true,
    remaining: detail.total,
    total: detail.dailyQuota ?? null,
    resetAt: null,
    lastUpdatedAt: now,
    rawJson: JSON.stringify(detail),
  }
}

/** Trigger the daily quota reset (idempotent via `alreadyProcessed`). */
export async function claimLoomyDailyQuota(deps: LoomyCreditsDeps): Promise<ClaimOutcome> {
  if (isLoomyExpired(deps.credential)) {
    return { kind: 'needs_auth', message: 'Loomy session expired; re-login required' }
  }
  const res = await deps.fetcher(`${deps.product.apiBase}${LOOMY_FIRST_LOGIN_PATH}`, {
    method: 'POST',
    headers: { ...loomyBusinessHeaders(deps.credential.access_token), 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { kind: 'needs_auth', message: `HTTP ${res.status}` }
    if (res.status === 429) return { kind: 'rate_limited', message: `HTTP ${res.status}` }
    return { kind: 'failed', message: `HTTP ${res.status}` }
  }
  const envelope = parseLoomyEnvelope(await res.json().catch(() => null))
  if (!envelope.ok) {
    return envelope.code === '100002'
      ? { kind: 'needs_auth', message: 'session expired; re-login required' }
      : { kind: 'failed', message: `code ${envelope.code}` }
  }
  if (envelope.data.alreadyProcessed === true) {
    return { kind: 'already_claimed', message: "today's allowance was already initialized" }
  }
  const quota = readNumber(envelope.data.dailyQuota)
  const consumed = readNumber(envelope.data.dailyConsumed)
  const granted = quota !== undefined && consumed !== undefined ? Math.max(0, quota - consumed) : 0
  return { kind: 'success', credit: granted, message: "today's allowance initialized" }
}
