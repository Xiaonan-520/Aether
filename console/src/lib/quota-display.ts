/**
 * Quota display helpers.
 *
 * A provider can have several accounts, each with its own quota snapshot. The
 * console never invents an aggregate: a total is only produced when every
 * known account reports the same single resource (same id/kind/unit), and the
 * UI always labels how many accounts the total covers. Unknown accounts are
 * counted separately instead of being coerced to zero.
 */
import type { QuotaResource } from './api'
import { formatQuota } from './status'

export interface QuotaSummaryItem {
  accountId: string
  label: string
  value: string
  unit: string | null
  unknown: boolean
  lastUpdatedAt: number | null
  resetAt: number | null
}

export type QuotaSummary =
  | { kind: 'none' }
  | { kind: 'single'; value: string; unknown: boolean; lastUpdatedAt: number | null; resetAt: number | null }
  | {
      kind: 'aggregate'
      accountCount: number
      knownCount: number
      unknownCount: number
      value: string
      unit: string | null
      lastUpdatedAt: number | null
      resetAt: number | null
    }
  | { kind: 'unavailable'; accountCount: number }
  | { kind: 'list'; accountCount: number; items: QuotaSummaryItem[] }

/** Only a single-resource V1 snapshot has an unambiguous unit for the projected value. */
function soleResource(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const resources = (raw as { resources?: unknown }).resources
  if (!Array.isArray(resources) || resources.length !== 1) return null
  const resource = resources[0]
  return resource && typeof resource === 'object' ? (resource as Record<string, unknown>) : null
}

export function quotaUnit(raw: unknown): string | null {
  const resource = soleResource(raw)
  return resource && typeof resource.unit === 'string' && resource.unit.length > 0
    ? resource.unit
    : null
}

/**
 * A stable comparability key. A total is only safe when every account reports
 * the same resource id, kind and unit; `custom` is never summed.
 */
function quotaUnitKey(raw: unknown): string | null {
  const resource = soleResource(raw)
  if (!resource) return null
  const { id, kind, unit } = resource
  if (typeof id !== 'string' || typeof kind !== 'string' || typeof unit !== 'string') return null
  if (kind === 'custom' || unit.length === 0) return null
  return `${id}:${kind}:${unit}`
}

export function quotaSource(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const source = (raw as { source?: unknown }).source
  return typeof source === 'string' ? source : null
}

export interface AccountQuotaView {
  known: boolean
  remaining: number | null
  total: number | null
  resetAt: number | null
  unit: string | null
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isoToMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function remainingRatio(resource: Record<string, unknown>): number {
  const remaining = numeric(resource.remaining) ?? 0
  const total = numeric(resource.total)
  return total !== null && total > 0 ? remaining / total : 1
}

/**
 * Project the account's stored quota JSON for the compact Accounts table.
 * Mirrors the core's V1 → legacy projection (scarcest routable resource) so
 * the table and the per-account quota cards agree on the same number.
 */
export function readAccountQuota(quotaJson: string | null): AccountQuotaView | null {
  if (!quotaJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(quotaJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const resources = (parsed as { resources?: unknown }).resources
  if (Array.isArray(resources)) {
    const routable = resources.filter((resource): resource is Record<string, unknown> => {
      if (!resource || typeof resource !== 'object') return false
      const record = resource as Record<string, unknown>
      return record.kind !== 'custom' && numeric(record.remaining) !== null
    })
    if (routable.length === 0) {
      return { known: false, remaining: null, total: null, resetAt: null, unit: null }
    }
    const scarcest = routable.reduce((a, b) => (remainingRatio(a) <= remainingRatio(b) ? a : b))
    return {
      known: true,
      remaining: numeric(scarcest.remaining),
      total: numeric(scarcest.total),
      resetAt: isoToMs(scarcest.resetAt),
      unit: typeof scarcest.unit === 'string' ? scarcest.unit : null,
    }
  }

  const legacy = parsed as {
    known?: unknown
    remaining?: unknown
    total?: unknown
    resetAt?: unknown
  }
  return {
    known: Boolean(legacy.known),
    remaining: numeric(legacy.remaining),
    total: numeric(legacy.total),
    resetAt: numeric(legacy.resetAt),
    unit: null,
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function latest(values: Array<number | null>): number | null {
  let result: number | null = null
  for (const value of values) {
    if (value !== null && (result === null || value > result)) result = value
  }
  return result
}

function earliest(values: Array<number | null>): number | null {
  let result: number | null = null
  for (const value of values) {
    if (value !== null && (result === null || value < result)) result = value
  }
  return result
}

export function summarizeQuotas(quotas: QuotaResource[]): QuotaSummary {
  if (quotas.length === 0) return { kind: 'none' }

  if (quotas.length === 1) {
    const quota = quotas[0]
    const { value, unknown } = formatQuota(quota.remaining, quota.total)
    if (quota.known && !(quota.remaining === null && quota.total === null)) {
      return {
        kind: 'single',
        value,
        unknown,
        lastUpdatedAt: quota.lastUpdatedAt,
        resetAt: quota.resetAt,
      }
    }
    if (quota.lastUpdatedAt !== null) {
      return {
        kind: 'single',
        value: 'Snapshot without numeric quota',
        unknown: true,
        lastUpdatedAt: quota.lastUpdatedAt,
        resetAt: null,
      }
    }
    return { kind: 'single', value: 'Unknown', unknown: true, lastUpdatedAt: null, resetAt: null }
  }

  // Only a numeric remaining value can be summed; a known snapshot with only a
  // total is shown per account rather than being coerced into the total.
  const known = quotas.filter(
    (quota) =>
      quota.known && typeof quota.remaining === 'number' && Number.isFinite(quota.remaining),
  )
  const unitKeys = new Set(known.map((quota) => quotaUnitKey(quota.raw)))
  const canAggregate = known.length > 0 && unitKeys.size === 1 && !unitKeys.has(null)

  if (canAggregate) {
    const remaining = round(known.reduce((sum, quota) => sum + (quota.remaining as number), 0))
    const allTotalsKnown = known.every(
      (quota) => typeof quota.total === 'number' && Number.isFinite(quota.total),
    )
    const total = allTotalsKnown
      ? round(known.reduce((sum, quota) => sum + (quota.total as number), 0))
      : null
    return {
      kind: 'aggregate',
      accountCount: quotas.length,
      knownCount: known.length,
      unknownCount: quotas.length - known.length,
      value: formatQuota(remaining, total).value,
      unit: quotaUnit(known[0].raw),
      lastUpdatedAt: latest(known.map((quota) => quota.lastUpdatedAt)),
      resetAt: earliest(known.map((quota) => quota.resetAt)),
    }
  }

  if (known.length === 0) {
    return { kind: 'unavailable', accountCount: quotas.length }
  }

  return {
    kind: 'list',
    accountCount: quotas.length,
    items: quotas.map((quota) => {
      const { value, unknown } = formatQuota(quota.remaining, quota.total)
      return {
        accountId: quota.accountId,
        label: quota.accountDisplayName || quota.accountId,
        value,
        unit: quotaUnit(quota.raw),
        unknown: unknown || !quota.known || quota.remaining === null,
        lastUpdatedAt: quota.lastUpdatedAt,
        resetAt: quota.resetAt,
      }
    }),
  }
}
