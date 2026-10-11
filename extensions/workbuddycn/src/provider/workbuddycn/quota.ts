/**
 * Quota / credits. Fetches the standardized "credits" projection from the
 * upstream `get-user-resource` endpoint and caches it. The raw upstream package
 * JSON is normalized here and never exposed in its raw provider-specific form.
 */
import type { QuotaResource, QuotaSnapshotV1 } from '../../protocol/types.js'
import type { Store } from '../../storage/store.js'
import type { UpstreamClient } from './client.js'
import { USER_RESOURCE_PATH } from './paths.js'
import { roundCredits } from './parsing.js'

export const QUOTA_CACHE_TTL_MS = 60 * 1000

export interface RawCreditBalance {
  total: number
  packages: CreditPackageSummary[]
  expiredTotal: number
}

export interface CreditPackageSummary {
  name: string
  unit: string
  remaining: number
  total: number
  used: number
  active: boolean
  cycleEndTime: string
  deductionEndTime?: number
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

function readPrecise(source: Record<string, unknown>, base: string): number {
  const precise = source[`${base}Precise`]
  if (typeof precise === 'string') {
    const parsed = Number.parseFloat(precise)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof precise === 'number' && Number.isFinite(precise)) return precise
  return readNumber(source, base)
}

const PACKAGE_STATUS_EXPIRED = 3

function parsePackage(entry: Record<string, unknown>): CreditPackageSummary {
  const name = readString(entry, 'PackageName')
    || readString(entry, 'SubProductName')
    || readString(entry, 'PackageCode')
  const unit = readString(entry, 'CapacityUnit') || readString(entry, 'OriginUnit') || 'credits'
  const status = entry.Status
  const expiredTime = readString(entry, 'ExpiredTime')
  const deductionEndTime = readNumber(entry, 'DeductionEndTime')
  const expiredAt = expiredTime.length > 0 ? Date.parse(expiredTime.replace(' ', 'T')) : Number.NaN
  const active = status !== PACKAGE_STATUS_EXPIRED
    && !(Number.isFinite(expiredAt) && Date.now() >= expiredAt)
    && !(deductionEndTime > 0 && Date.now() >= deductionEndTime)
  return {
    name,
    unit,
    remaining: readPrecise(entry, 'CycleCapacityRemain'),
    total: readPrecise(entry, 'CycleCapacitySize'),
    used: readPrecise(entry, 'CycleCapacityUsed'),
    active,
    cycleEndTime: readString(entry, 'CycleEndTime'),
    ...(deductionEndTime > 0 ? { deductionEndTime } : {}),
  }
}

/** Parse the double-nested `get-user-resource` response body. */
export function parseCreditBalance(body: unknown): RawCreditBalance | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  if (record.code !== 0) return null
  const outer = record.data
  if (typeof outer !== 'object' || outer === null) return null
  const response = (outer as Record<string, unknown>).Response
  if (typeof response !== 'object' || response === null) return null
  const inner = (response as Record<string, unknown>).Data
  if (typeof inner !== 'object' || inner === null) return null
  const accounts = (inner as Record<string, unknown>).Accounts
  if (!Array.isArray(accounts)) return null

  const packages = accounts.map((item) => item && typeof item === 'object'
    ? parsePackage(item as Record<string, unknown>)
    : undefined).filter((p): p is CreditPackageSummary => Boolean(p))
  const total = roundCredits(
    packages.reduce((sum, p) => sum + (p.active ? p.remaining : 0), 0),
  )
  const expiredTotal = roundCredits(
    packages.reduce((sum, p) => sum + (p.active ? 0 : p.remaining), 0),
  )
  return { total, packages, expiredTotal }
}

/**
 * Fetch the standardized quota projection for an account. Returns cached data
 * when a fresh fetch fails but a recent cache exists.
 */
export async function fetchQuota(
  client: UpstreamClient,
  store: Store,
  accountId: string,
  preferCache = false,
): Promise<QuotaSnapshotV1> {
  const empty = (source: QuotaSnapshotV1['source']): QuotaSnapshotV1 => ({
    accountId,
    resources: [],
    checkedAt: new Date().toISOString(),
    source,
  })
  const credential = store.getCredential(accountId)
  if (!credential) return empty('authoritative')

  const cacheHit = store.getQuotaCache(accountId)
  const cacheFresh = cacheHit && Date.now() - cacheHit.fetchedAt < QUOTA_CACHE_TTL_MS
  const fromCache = (): QuotaSnapshotV1 | undefined => {
    if (!cacheHit) return undefined
    try {
      const parsed = JSON.parse(cacheHit.payload) as QuotaSnapshotV1
      return { ...parsed, accountId, source: 'cached' }
    } catch {
      return undefined
    }
  }
  if (preferCache && cacheFresh && cacheHit) {
    return fromCache() ?? empty('cached')
  }

  try {
    const { status, body } = await client.postBilling(credential, USER_RESOURCE_PATH)
    if (status !== 200) throw new Error(`quota HTTP ${status}`)
    const balance = parseCreditBalance(body)
    if (!balance) return fromCache() ?? empty('authoritative')
    const resetAt = earliestActiveReset(balance)
    const resource: QuotaResource = {
      id: 'credits',
      kind: 'credits',
      remaining: balance.total,
      total: roundCredits(balance.total + balance.expiredTotal),
      used: roundCredits(Math.max(0, balance.expiredTotal)),
      unit: 'credits',
      resetAt,
      status: balance.total <= 0 ? 'exhausted' : balance.total <= 50 ? 'low' : 'ok',
    }
    const snapshot: QuotaSnapshotV1 = {
      accountId,
      resources: [resource],
      checkedAt: new Date().toISOString(),
      source: 'authoritative',
    }
    store.putQuotaCache(accountId, JSON.stringify(snapshot))
    return snapshot
  } catch {
    return fromCache() ?? empty('cached')
  }
}

/** Earliest cycle-end among active packages as an ISO instant, or null. */
function earliestActiveReset(balance: RawCreditBalance): string | null {
  let earliest: number | undefined
  for (const pkg of balance.packages) {
    if (!pkg.active || pkg.cycleEndTime.length === 0) continue
    const ts = Date.parse(pkg.cycleEndTime.replace(' ', 'T'))
    if (!Number.isFinite(ts)) continue
    if (earliest === undefined || ts < earliest) earliest = ts
  }
  return earliest !== undefined ? new Date(earliest).toISOString() : null
}