/**
 * Buddy-family meter quota mapping (Tencent cloud billing meter format).
 *
 * Upstream: POST /v2/billing/meter/get-user-resource →
 *   { code: 0, data: { Response: { Data: { TotalCount, TotalDosage, Accounts: [...] } } } }
 *
 * Each Account entry is one credit package with Tencent-cloud billing fields:
 *   CapacityType   1 = purchased/expiry package, 4 = trial/period package
 *   CapacityUnit   'credits' (observed; anything else is passed through as-is)
 *   CapacitySize / CapacityRemain / CapacityUsed   numeric package amounts
 *   CycleStartTime / CycleEndTime   package validity window ('YYYY-MM-DD HH:mm:ss')
 *   Status         0 = active
 *
 * Mapping rules (§13 semantics — never invent data):
 * - Only entries with Status 0 (active) are reported; expired/paused packages
 *   disappear from the card rather than showing stale numbers.
 * - Each active package becomes its own quota resource (id = package index +
 *   type, e.g. `pkg-1-4`) so multi-package accounts stay legible; the legacy
 *   flat projection picks the scarcest (lowest remaining) for the Console card.
 * - Entries with a non-numeric or missing CapacityRemain are skipped — an
 *   unparseable package is unknown, not zero.
 * - resetAt comes from the package's own CycleEndTime (upstream-provided only).
 */

import type { QuotaResource } from '../../../protocol/extension/accounts.js'
import type { BuddyCredential, Fetcher } from './protocol.js'
import type { BuddyProduct } from './product.js'
import { credentialAuthHeaders } from './protocol.js'

export const USER_RESOURCE_PATH = '/v2/billing/meter/get-user-resource'

interface MeterAccount {
  CapacityType?: number
  CapacityUnit?: string
  CapacitySize?: number
  CapacityRemain?: number
  CapacityUsed?: number
  CycleStartTime?: string
  CycleEndTime?: string
  Status?: number
  PackageName?: string
}

interface MeterPayload {
  code?: number
  msg?: string
  data?: { Response?: { Data?: { TotalCount?: number; TotalDosage?: number; Accounts?: MeterAccount[] } } }
}

export interface MeterQuotaResult {
  resources: QuotaResource[]
  /** raw upstream summary for diagnostics (no credential material) */
  summary: { totalCount: number; totalDosage: number | null } | null
  error?: string
}

/** 'YYYY-MM-DD HH:mm:ss' (upstream, +08:00 local) → ISO with explicit +08:00. */
function cycleTimeToIso(value: string | undefined): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null
  return value.replace(' ', 'T') + '+08:00'
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function fetchMeterQuota(
  product: BuddyProduct,
  credential: BuddyCredential,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<MeterQuotaResult> {
  let response: Response
  try {
    response = await fetcher(`${product.endpoint}${USER_RESOURCE_PATH}`, {
      method: 'POST',
      headers: { ...credentialAuthHeaders(credential, product), 'Content-Type': 'application/json' },
      body: '{}',
      signal: signal ?? AbortSignal.timeout(20_000),
    })
  } catch (error) {
    return { resources: [], summary: null, error: `network error: ${String(error)}` }
  }

  let payload: MeterPayload
  try {
    payload = await response.json() as MeterPayload
  } catch {
    return { resources: [], summary: null, error: `HTTP ${response.status}: non-JSON response` }
  }

  if (payload.code !== 0) {
    return { resources: [], summary: null, error: `upstream code ${payload.code}: ${payload.msg ?? ''}`.trim() }
  }

  const data = payload.data?.Response?.Data
  if (!data) return { resources: [], summary: null, error: 'meter response missing data.Response.Data' }

  const resources: QuotaResource[] = []
  let packageIndex = 0
  for (const acc of data.Accounts ?? []) {
    packageIndex += 1
    // Only active packages. A non-zero Status means expired/paused — the
    // package is omitted entirely (no stale numbers, no zero-filling).
    if (acc.Status !== 0) continue
    const remain = numeric(acc.CapacityRemain)
    if (remain === null) continue // unparseable ⇒ unknown, not 0
    const unit = typeof acc.CapacityUnit === 'string' && acc.CapacityUnit !== '' ? acc.CapacityUnit : 'credits'
    const resetAt = cycleTimeToIso(acc.CycleEndTime)
    const typeLabel = acc.CapacityType === 4 ? 'trial' : 'pkg'
    resources.push({
      id: `pkg-${packageIndex}-${typeLabel}`,
      kind: 'credits',
      remaining: remain,
      total: numeric(acc.CapacitySize),
      used: numeric(acc.CapacityUsed),
      unit,
      resetAt,
      status: remain <= 0 ? 'exhausted' : remain < 10 ? 'low' : 'ok',
      metadata: { capacityType: acc.CapacityType ?? null, packageName: acc.PackageName ?? null },
    })
  }

  return {
    resources,
    summary: { totalCount: numeric(data.TotalCount) ?? resources.length, totalDosage: numeric(data.TotalDosage) },
  }
}
