/**
 * Cline credit balance.
 *
 * Verified reference: `GET {apiBase}/api/v1/users/{userId}/balance` →
 * `{success:true, data:{userId, balance}}`.
 *
 * NOTE ON UNITS: the reference observes `balance: 500000` and *suspects*
 * micro-USD, but states there is no source proof. The gateway therefore reports
 * the raw balance value as `remaining` with `unit: 'raw'` rather than inventing
 * a credit conversion. Cline has no daily check-in, so credits are not claimed.
 */
import type { QuotaSnapshot } from '../../core/types.js'
import { CLINE_BALANCE_PATH_PREFIX, type ClineProduct } from './product.js'
import { clineAuthHeaders, type ClineCredential, type Fetcher } from './protocol.js'

export interface ClineBalanceResult {
  known: boolean
  remaining: number | null
  /** raw upstream balance; see the unit caveat above */
  rawBalance: number | null
  rawJson: string | null
  lastUpdatedAt: number
}

export async function fetchClineBalance(
  credential: ClineCredential,
  product: ClineProduct,
  fetcher: Fetcher,
): Promise<ClineBalanceResult> {
  const now = Date.now()
  const unknown: ClineBalanceResult = {
    known: false, remaining: null, rawBalance: null, rawJson: null, lastUpdatedAt: now,
  }
  const userId = credential.user_id?.trim()
  if (!userId) return unknown
  const res = await fetcher(
    `${product.apiBase}${CLINE_BALANCE_PATH_PREFIX}${encodeURIComponent(userId)}/balance`,
    { headers: clineAuthHeaders(credential, product) },
  )
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok || body === null) return unknown
  const root = body as Record<string, unknown>
  const inner = typeof root.data === 'object' && root.data !== null ? (root.data as Record<string, unknown>) : root
  const balance = typeof inner.balance === 'number' && Number.isFinite(inner.balance) ? inner.balance : null
  if (balance === null) return unknown
  return {
    known: true,
    remaining: balance,
    rawBalance: balance,
    rawJson: JSON.stringify({ balance, unit: 'raw' }),
    lastUpdatedAt: now,
  }
}

export function toQuotaSnapshot(balance: ClineBalanceResult): QuotaSnapshot {
  return {
    known: balance.known,
    remaining: balance.remaining,
    total: null,
    resetAt: null,
    lastUpdatedAt: balance.lastUpdatedAt,
    rawJson: balance.rawJson,
  }
}
