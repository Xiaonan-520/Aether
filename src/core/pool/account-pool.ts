/**
 * Account Pool: account selection, cooldown / rate-limit / quota state machine.
 *
 * Selection mirrors the original harness AccountPool semantics
 * (enabled + per-model rolling rate-limit window + LRU), extended with the
 * status machine from core/types.ts. Error-driven transitions are reported by
 * the service layer via reportResult(); the pool never sees raw upstream
 * errors, only normalized UpstreamError kinds.
 */
import type { Account, ModelRateLimit } from '../types.js'
import type { UpstreamError } from '../errors/upstream-error.js'

/** How many consecutive transport-ish failures put an account into cooldown. */
const FAILURE_COOLDOWN_THRESHOLD = 3
/** Base cooldown for repeated transport failures; grows exponentially. */
const FAILURE_COOLDOWN_BASE_MS = 60_000
const FAILURE_COOLDOWN_MAX_MS = 30 * 60_000
/** Default per-model rate-limit window when upstream gives no retry-after. */
const DEFAULT_RATE_LIMIT_MS = 60_000
/** How long one request may hold an in-flight slot before it is swept. */
const DEFAULT_LEASE_TTL_MS = 10 * 60_000
/**
 * Statuses that mean the account is healthy now. `healthy_low_quota` is still
 * routable and must stay in this tier; all other selectable statuses are
 * recovering accounts whose cooldown has expired.
 */
const HEALTHY_STATUSES = new Set<Account['status']>(['active', 'healthy_low_quota'])

export interface SelectOptions {
  /** requested model (upstream id) for per-model rate-limit filtering */
  model?: string
  /** accounts to skip (already failed during this request's failover) */
  exclude?: Set<string>
}

export interface SelectedAccount {
  account: Account
  /** release the in-flight slot taken for this selection */
  release: () => void
}

export interface PoolDeps {
  /** all stored accounts for a provider (already decrypted-agnostic) */
  listAccounts: (provider: string) => Account[]
  /** latest account by id (preferred over listAccounts for outcome updates) */
  getAccount?: (id: string) => Account | undefined
  /** persist a mutated account */
  patchAccount: (id: string, patch: Partial<Account>) => void
  /** resolve credential presence without exposing the secret */
  hasCredential: (account: Account) => boolean
  /**
   * Inline refresh hook: called when the selected account's token is expired
   * and refreshable. May throw UpstreamError. Implementations must be
   * single-flight per account.
   */
  refreshAccount?: (account: Account) => Promise<Account>
  /** monotonic-ish clock injection for tests */
  now?: () => number
  /** in-flight lease TTL (default 10 minutes) */
  leaseTtlMs?: number
}

export class AccountPool {
  /**
   * In-flight requests per account. Purely in-memory coordination: it spreads
   * concurrent requests across accounts and is released the moment a request
   * finishes, fails or is cancelled. It is NOT a quota reservation and is never
   * persisted, so a crashed process cannot leave an account stuck.
   */
  private readonly inflight = new Map<string, number>()
  private readonly leaseStartedAt = new Map<string, number[]>()

  constructor(private readonly deps: PoolDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Current in-flight count for an account (diagnostics / tests). */
  inflightCount(accountId: string): number {
    return this.inflight.get(accountId) ?? 0
  }

  /**
   * Take an in-flight slot for an account. Must be paired with release().
   * Expired slots (a leaked lease from an abandoned request) are swept first so
   * a bug in a caller cannot permanently reduce capacity.
   */
  acquire(accountId: string): void {
    this.sweepExpiredLeases()
    this.inflight.set(accountId, (this.inflight.get(accountId) ?? 0) + 1)
    const started = this.leaseStartedAt.get(accountId) ?? []
    started.push(this.now())
    this.leaseStartedAt.set(accountId, started)
  }

  /** Release an in-flight slot; safe to call once per acquire(). */
  release(accountId: string): void {
    const count = this.inflight.get(accountId) ?? 0
    if (count <= 1) this.inflight.delete(accountId)
    else this.inflight.set(accountId, count - 1)
    const started = this.leaseStartedAt.get(accountId)
    if (started && started.length > 0) {
      started.shift()
      if (started.length === 0) this.leaseStartedAt.delete(accountId)
    }
  }

  /** Drop leases older than the lease TTL (a request that never released). */
  private sweepExpiredLeases(): void {
    const cutoff = this.now() - this.leaseTtlMs()
    for (const [accountId, started] of this.leaseStartedAt) {
      const live = started.filter((at) => at > cutoff)
      const dropped = started.length - live.length
      if (dropped === 0) continue
      if (live.length === 0) {
        this.leaseStartedAt.delete(accountId)
        this.inflight.delete(accountId)
        continue
      }
      this.leaseStartedAt.set(accountId, live)
      const remaining = (this.inflight.get(accountId) ?? 0) - dropped
      if (remaining > 0) this.inflight.set(accountId, remaining)
      else this.inflight.delete(accountId)
    }
  }

  private leaseTtlMs(): number {
    return this.deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  }

  /**
   * Pick the best available account for a provider.
   * Order: not-excluded → enabled + selectable status → credential present →
   * per-model rate-limit window passed → cooldown passed → healthy tier →
   * priority then LRU.
   */
  async selectAccount(provider: string, opts: SelectOptions = {}): Promise<SelectedAccount | null> {
    const now = this.now()
    const exclude = opts.exclude ?? new Set<string>()
    const candidates = this.deps
      .listAccounts(provider)
      .filter((a) => !exclude.has(a.id))
      .filter((a) => a.enabled)
      .filter((a) => AccountPool.isSelectable(a, now))
      .filter((a) => this.deps.hasCredential(a))
      .filter((a) => opts.model === undefined || AccountPool.rateLimitCleared(a, opts.model, now))
      .filter((a) => opts.model === undefined || AccountPool.supportsModel(a, opts.model))
      .filter((a) => !(this.isTokenExpired(a, now) && !a.refreshable))

    if (candidates.length === 0) return null

    // Accounts whose cooldown just expired are selectable again, but an account
    // that keeps failing never advances lastSuccessAt and therefore stays at
    // the front of the LRU order. Prefer accounts that are healthy right now;
    // recovering accounts remain fallbacks when no healthy account can serve
    // this request. This is a status tier, not a priority override.
    const healthy = candidates.filter((a) => HEALTHY_STATUSES.has(a.status))
    const pool = healthy.length > 0 ? healthy : candidates

    // manual priority (provider metadata `priority`), then fewest in-flight
    // requests, then least-recently-used. The in-flight term spreads concurrent
    // requests that would otherwise all pick the same LRU winner; it never
    // overrides an explicit priority.
    pool.sort((a, b) => {
      const pa = priorityOf(a)
      const pb = priorityOf(b)
      if (pa !== pb) return pb - pa
      const ia = this.inflightCount(a.id)
      const ib = this.inflightCount(b.id)
      if (ia !== ib) return ia - ib
      return (a.lastSuccessAt ?? 0) - (b.lastSuccessAt ?? 0)
    })

    for (const candidate of pool) {
      if (this.isTokenExpired(candidate, now) && candidate.refreshable) {
        try {
          const refreshed = await this.deps.refreshAccount?.(candidate)
          if (refreshed) return this.lease(refreshed)
        } catch {
          // refresh failed: mark and try the next candidate
          this.deps.patchAccount(candidate.id, {
            status: 'auth_failed',
            lastError: 'token refresh failed during selection',
            lastFailureAt: now,
          })
          continue
        }
      }
      return this.lease(candidate)
    }
    return null
  }

  /** Take an in-flight slot and hand back its release function. */
  private lease(account: Account): SelectedAccount {
    this.acquire(account.id)
    let released = false
    return {
      account,
      release: () => {
        // idempotent: a double release would hand out a phantom slot
        if (released) return
        released = true
        this.release(account.id)
      },
    }
  }

  private isTokenExpired(account: Account, now: number): boolean {
    return account.tokenExpiryAt !== null && account.tokenExpiryAt <= now
  }

  /** Statuses eligible for selection; cooldown expiry is applied lazily here. */
  static isSelectable(account: Account, now: number): boolean {
    if (account.cooldownUntil !== null && account.cooldownUntil > now) return false
    return (
      account.status === 'active' ||
      account.status === 'healthy_low_quota' ||
      // cooldown status with an expired cooldown window falls back to active
      (account.status === 'cooldown' && (account.cooldownUntil === null || account.cooldownUntil <= now)) ||
      // rate_limited recovers via the same cooldown clock; without this a single
      // 429 on a non-refreshable provider would park the account forever
      (account.status === 'rate_limited' && (account.cooldownUntil === null || account.cooldownUntil <= now))
    )
  }

  static rateLimitCleared(account: Account, model: string, now: number): boolean {
    const limit = account.modelRateLimits[model]
    if (!limit) return true
    return limit.resetAtMs <= now
  }

  /**
   * Account-level model capability.
   *
   * Some accounts of the same provider are entitled to different model
   * catalogs. When an account declares its catalog in
   * `providerMetadataJson.models` (an array of upstream model ids or public
   * `provider::model` ids), an account that explicitly does not list the
   * requested model is skipped. Unknown metadata means "no per-account
   * evidence" and stays eligible: the conservative default is to try, because
   * a false negative would silently remove a working account.
   */
  static supportsModel(account: Account, model: string): boolean {
    const declared = declaredModelsOf(account)
    if (declared === null) return true
    if (declared.length === 0) return false
    return declared.some((entry) => entry === model || entry.endsWith(`::${model}`))
  }

  /**
   * Report the outcome of a chat/ops attempt; drives the account state machine.
   * `error === undefined` means success.
   */
  reportResult(account: Account, error?: UpstreamError): Account {
    const now = this.now()
    // In-flight requests all hold the account snapshot captured at selection
    // time. Re-read the latest persisted row before applying an outcome so
    // concurrent failures accumulate instead of overwriting each other with
    // the same stale failureCount (which would prevent cooldown / backoff).
    const current = (this.deps.getAccount?.(account.id)
      ?? this.deps.listAccounts(account.provider).find((a) => a.id === account.id)
      ?? account)

    if (!error) {
      const next: Account = {
        ...current,
        status: 'active',
        failureCount: 0,
        lastSuccessAt: now,
        lastError: null,
        cooldownUntil: null,
        updatedAt: now,
      }
      this.deps.patchAccount(current.id, next)
      return next
    }

    switch (error.kind) {
      case 'AUTH_INVALID':
      case 'TOKEN_EXPIRED': {
        const next = this.patch(current, {
          status: 'token_expired',
          lastError: error.message,
          lastFailureAt: now,
        })
        return next
      }
      case 'RATE_LIMIT': {
        const model = error.detail?.match(/model:(\S+)/)?.[1]
        const windowMs = error.retryAfterMs ?? DEFAULT_RATE_LIMIT_MS
        const rateLimits = { ...current.modelRateLimits }
        if (model) rateLimits[model] = { resetAtMs: now + windowMs }
        return this.patch(current, {
          status: 'rate_limited',
          modelRateLimits: rateLimits,
          lastError: error.message,
          lastFailureAt: now,
          // account-level cooldown only when we cannot attribute a model
          cooldownUntil: model ? current.cooldownUntil : now + windowMs,
        })
      }
      case 'QUOTA_EXHAUSTED': {
        return this.patch(current, {
          status: 'quota_exhausted',
          lastError: error.message,
          lastFailureAt: now,
        })
      }
      case 'NEEDS_CAPTCHA':
      case 'NEEDS_MANUAL': {
        return this.patch(current, {
          status: 'needs_manual_action',
          quotaManualRequired: error.kind === 'NEEDS_CAPTCHA' ? true : current.quotaManualRequired,
          lastError: error.message,
          lastFailureAt: now,
        })
      }
      case 'TERMINAL': {
        // business rejection: do not poison the account, but record it
        return this.patch(current, {
          lastError: error.message,
          lastFailureAt: now,
        })
      }
      default: {
        // TIMEOUT / TRANSPORT / UPSTREAM_5XX / EMPTY_RESPONSE: consecutive failures
        const failureCount = current.failureCount + 1
        if (failureCount >= FAILURE_COOLDOWN_THRESHOLD) {
          const backoff = Math.min(
            FAILURE_COOLDOWN_BASE_MS * 2 ** (failureCount - FAILURE_COOLDOWN_THRESHOLD),
            FAILURE_COOLDOWN_MAX_MS,
          )
          return this.patch(current, {
            status: 'cooldown',
            failureCount,
            cooldownUntil: now + backoff,
            lastError: error.message,
            lastFailureAt: now,
          })
        }
        return this.patch(current, {
          failureCount,
          lastError: error.message,
          lastFailureAt: now,
        })
      }
    }
  }

  private patch(account: Account, changes: Partial<Account>): Account {
    const next: Account = { ...account, ...changes, updatedAt: this.now() }
    this.deps.patchAccount(account.id, next)
    return next
  }
}

function priorityOf(account: Account): number {
  if (!account.providerMetadataJson) return 0
  try {
    const meta = JSON.parse(account.providerMetadataJson) as { priority?: number }
    return typeof meta.priority === 'number' ? meta.priority : 0
  } catch {
    return 0
  }
}

export type { ModelRateLimit }

/**
 * Read an account's declared model catalog. Returns null when the account does
 * not declare one (unknown → eligible), and a (possibly empty) array when it
 * does.
 */
function declaredModelsOf(account: Account): string[] | null {
  if (!account.providerMetadataJson) return null
  let meta: unknown
  try {
    meta = JSON.parse(account.providerMetadataJson)
  } catch {
    return null
  }
  if (!meta || typeof meta !== 'object') return null
  const models = (meta as { models?: unknown }).models
  if (!Array.isArray(models)) return null
  return models.filter((value): value is string => typeof value === 'string' && value.length > 0)
}
