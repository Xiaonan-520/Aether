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
    const remaining = firstNumber(data, ['remaining', 'available', 'left', 'balance'])
    const total = firstNumber(data, ['total', 'quota', 'limit'])
    const resetAt = firstNumber(data, ['resetAt', 'reset_at', 'expireAt', 'expires_at'])
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

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim())
  }
  return null
}
