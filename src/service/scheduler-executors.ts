/**
 * Scheduler executors (Phase 3B).
 *
 * Registered once at bootstrap. Each executor is idempotent per account and
 * delegates to the provider adapter; the Scheduler itself owns retry, backoff,
 * cooldown and concurrency.
 *
 * credit_claim closes the day on the FIRST recorded attempt (any outcome), so a
 * failure never retries in a loop; the upstream reports "already claimed" as a
 * normal result.
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
}

export function registerSchedulerExecutors(
  scheduler: Scheduler,
  deps: SchedulerExecutorDeps,
): void {
  const { store, registry, providerCtx } = deps
  const adapterFor = (provider: string) => registry.get(provider)

  scheduler.setExecutor('token_refresh', async (_job, account: Account) => {
    const adapter = adapterFor(account.provider)
    if (!adapter?.ops.refreshAccount) return { skipped: 'unsupported' }
    const result = await adapter.ops.refreshAccount(providerCtx(account.provider), account)
    if (result.refreshed) {
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
    if (store.isClaimedToday(account.id, 'credit_claim', today)) {
      return { skipped: 'already_attempted_today' }
    }
    const outcome = await adapter.ops.claimCredits(providerCtx(account.provider), account)
    store.recordClaim(account.id, account.provider, 'credit_claim', at, outcome)
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
