/**
 * Scheduler executors (Phase 3B).
 *
 * Registered once at bootstrap. Each executor is idempotent per account and
 * delegates to the provider adapter; the Scheduler itself owns retry, backoff,
 * cooldown and concurrency.
 *
 * credit_claim is polled every 30 minutes. The adapter reads the authoritative
 * status first and only claims when a claim is actually needed, so polling is
 * cheap and safe. The day is closed by the first *real claim attempt*
 * (success / already_claimed / failure / auth problem), which keeps retries
 * bounded; a status-only `not_available` does not close the day, so an
 * activity that opens later in the day is still picked up.
 */
import type { Scheduler } from '../core/worker/scheduler.js'
import type { ProviderRegistry } from '../core/registry/provider-registry.js'
import type { ProviderCtx } from '../core/registry/provider.js'
import type { StoreGateway } from '../store/types.js'
import type { Account } from '../core/types.js'
import { dayKey } from '../store/memory-store.js'

export interface SchedulerExecutorDeps {
  store: StoreGateway
  registry: ProviderRegistry
  providerCtx: (provider: string) => ProviderCtx
  /** persists a refreshed credential (rotating-token providers need this) */
  persistCredential?: (account: Account, credential: unknown) => void
}

export function registerSchedulerExecutors(
  scheduler: Scheduler,
  deps: SchedulerExecutorDeps,
): void {
  const { store, registry, providerCtx, persistCredential } = deps
  const adapterFor = (provider: string) => registry.get(provider)

  scheduler.setExecutor('token_refresh', async (_job, account: Account) => {
    const adapter = adapterFor(account.provider)
    if (!adapter?.ops.refreshAccount) return { skipped: 'unsupported' }
    const result = await adapter.ops.refreshAccount(providerCtx(account.provider), account)
    if (result.refreshed) {
      // Rotating-refresh providers return the new credential; persist it before
      // anything else so a rotated token is never lost.
      if (result.credential !== undefined) persistCredential?.(account, result.credential)
      store.patchAccount(account.id, { tokenExpiryAt: result.expiresAt, status: 'active' })
    }
    return result
  })

  scheduler.setExecutor('quota_sync', async (_job, account: Account) => {
    const adapter = adapterFor(account.provider)
    if (!adapter?.ops.getQuota) return { skipped: 'unsupported' }
    const quota = await adapter.ops.getQuota(providerCtx(account.provider), account)
    store.patchAccount(account.id, { quotaJson: quota.rawJson, lastQuotaAt: quota.lastUpdatedAt })
    return { known: quota.known, remaining: quota.remaining }
  })

  scheduler.setExecutor('credit_claim', async (job, account: Account) => {
    const adapter = adapterFor(account.provider)
    if (!adapter?.ops.claimCredits) return { skipped: 'unsupported' }
    // Use the scheduler's clock so the day boundary matches the injected `now`
    // (and stays testable) rather than wall-clock time.
    const at = job.scheduledAt ?? Date.now()
    const today = dayKey(at)
    const last = store.lastClaimOutcome(account.id, 'credit_claim', today)
    if (last !== null && last.kind !== 'not_available') {
      return { skipped: 'already_attempted_today' }
    }
    const outcome = await adapter.ops.claimCredits(providerCtx(account.provider), account)
    // `not_available` means no claim was attempted (e.g. the activity is not
    // running), so it must NOT close the day: the 30-minute poll keeps
    // checking. Any real attempt closes the day, bounding retries.
    if (outcome.kind !== 'not_available') {
      store.recordClaim(account.id, account.provider, 'credit_claim', at, outcome)
    }
    if (outcome.kind === 'success') {
      store.patchAccount(account.id, { lastCreditClaimAt: at, status: 'active' })
    } else if (outcome.kind === 'needs_manual_action') {
      store.patchAccount(account.id, { quotaManualRequired: true, status: 'needs_manual_action' })
    }
    return outcome
  })

  scheduler.setExecutor('health_check', async (_job, account: Account) => {
    const adapter = adapterFor(account.provider)
    if (!adapter?.ops.healthCheck) return { skipped: 'unsupported' }
    return adapter.ops.healthCheck(providerCtx(account.provider), account)
  })
}
