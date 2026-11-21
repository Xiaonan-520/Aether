/**
 * ZCode 配额读取（billing + balance 双平面）。
 *
 * 移植自 Core 内置适配器的 fetchQuota，逻辑保持一致：billing 为主、
 * balance 兜底；字段探测顺序与内置版相同（remaining/available/left/balance
 * 与 total/quota/limit）。失败时返回 known:false 而不是抛——面板宁可显示
 * "未知"也不伪造数字（声明式额度契约的要求）。
 */
import { ZCODE_API_BASE, authHeaders, type ZCodeCredential } from './upstream-auth.js'

export type Fetcher = typeof fetch

export interface QuotaFetchResult {
  known: boolean
  remaining: number | null
  total: number | null
  resetAt: number | null
  lastUpdatedAt: number
  rawJson: string | null
}

export async function fetchQuotaRaw(
  credential: ZCodeCredential,
  fetcher: Fetcher = fetch,
  apiBase: string = ZCODE_API_BASE,
): Promise<QuotaFetchResult> {
  const headers = { 'Content-Type': 'application/json', ...authHeaders(credential) }
  const now = Date.now()
  try {
    const [billingRes, balanceRes] = await Promise.all([
      fetcher(`${apiBase}/zcode-plan/billing/current`, { headers }),
      fetcher(`${apiBase}/zcode-plan/billing/balance`, { headers }).catch(() => null),
    ])
    if (!billingRes.ok) {
      return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now, rawJson: null }
    }
    const billing = (await billingRes.json()) as Record<string, unknown>
    const balance = balanceRes?.ok ? ((await balanceRes.json()) as Record<string, unknown>) : null
    const data = (billing.data ?? billing) as Record<string, unknown>
    // Two response shapes are live:
    //   flat      { data: { remaining, total, reset_at } }        (older plans)
    //   plan-list { data: { plans: [{ ends_at,
    //                               entitlements: [{ grant_units }] }] } }
    // The plan-list shape carries no `used`/`remaining` counter at all, so the
    // grant is reported as the *total* and remaining stays null — never derive
    // remaining from the grant (that would claim untouched quota we cannot see).
    const planTotals = sumPlanGrants(data)
    const remaining = firstNumber(data, ['remaining', 'available', 'left', 'balance'])
    const total = firstNumber(data, ['total', 'quota', 'limit']) ?? planTotals.total
    const resetAt = firstNumber(data, ['resetAt', 'reset_at', 'expireAt', 'expires_at']) ?? planTotals.resetAt
    return {
      known: remaining !== null || total !== null,
      remaining,
      total,
      resetAt,
      lastUpdatedAt: now,
      rawJson: JSON.stringify({ billing, balance }),
    }
  } catch {
    return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now, rawJson: null }
  }
}

/**
 * Sum `data.plans[].entitlements[].grant_units` for the active plans and take
 * the latest `ends_at`. Returns nulls when the payload has no plan list.
 */
function sumPlanGrants(data: Record<string, unknown>): { total: number | null; resetAt: number | null } {
  const plans = data.plans
  if (!Array.isArray(plans) || plans.length === 0) return { total: null, resetAt: null }
  let total = 0
  let sawGrant = false
  let resetAt: number | null = null
  for (const plan of plans as Array<Record<string, unknown>>) {
    if (typeof plan.status === 'string' && plan.status.toLowerCase() !== 'active') continue
    const entitlements = plan.entitlements
    if (Array.isArray(entitlements)) {
      for (const ent of entitlements as Array<Record<string, unknown>>) {
        const grant = firstNumber(ent, ['grant_units', 'grantUnits'])
        if (grant !== null) {
          total += grant
          sawGrant = true
        }
      }
    }
    const endsAt = firstNumber(plan, ['ends_at', 'endsAt'])
    if (endsAt !== null && (resetAt === null || endsAt > resetAt)) resetAt = endsAt * 1000
  }
  return { total: sawGrant ? total : null, resetAt }
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim())
  }
  return null
}
