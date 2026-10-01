import { describe, expect, it, vi } from 'vitest'
import { Scheduler, type JobType } from '../src/core/worker/scheduler.js'
import { MemoryStore } from '../src/store/memory-store.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { MockProvider } from './fixtures/mock-provider.js'
import { UpstreamError } from '../src/core/errors/upstream-error.js'
import type { Account } from '../src/core/types.js'

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'mock-a1',
    provider: 'mock',
    displayName: 'a1',
    status: 'active',
    enabled: true,
    authenticated: true,
    tokenExpiryAt: null,
    refreshable: false,
    credentialKey: 'CRED_A1',
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    cooldownUntil: null,
    modelRateLimits: {},
    quotaJson: null,
    lastQuotaAt: null,
    lastCreditClaimAt: null,
    quotaManualRequired: false,
    providerMetadataJson: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

interface Harness {
  store: MemoryStore
  scheduler: Scheduler
  now: number
  advance: (ms: number) => void
  executed: Array<{ jobType: string; accountId: string }>
}

function setup(accounts: Account[], opts: { tickIntervalMs?: number; supportsCredits?: boolean } = {}): Harness {
  const store = new MemoryStore()
  const registry = new ProviderRegistry()
  registry.register(new MockProvider({ capabilities: { supportsCredits: opts.supportsCredits ?? false } }))
  for (const acc of accounts) store.createAccount(acc)
  const state: Harness = {
    store,
    now: 1_700_000_000_000,
    advance(ms: number) {
      state.now += ms
    },
    executed: [],
    scheduler: undefined as unknown as Scheduler,
  }
  const scheduler = new Scheduler({
    store,
    registry,
    now: () => state.now,
    tickIntervalMs: opts.tickIntervalMs ?? 60_000,
  })
  scheduler.setExecutor('token_refresh', async (job) => {
    state.executed.push({ jobType: job.jobType, accountId: job.accountId! })
    return { refreshed: true }
  })
  scheduler.setExecutor('quota_sync', async (job) => {
    state.executed.push({ jobType: job.jobType, accountId: job.accountId! })
    return { remaining: 50 }
  })
  scheduler.setExecutor('credit_claim', async (job) => {
    state.executed.push({ jobType: job.jobType, accountId: job.accountId! })
    return { kind: 'success', credit: 10 }
  })
  scheduler.setExecutor('health_check', async (job) => {
    state.executed.push({ jobType: job.jobType, accountId: job.accountId! })
    return { ok: true }
  })
  state.scheduler = scheduler
  return state
}

describe('scheduler — scans and enqueueing', () => {
  it('token_refresh scan enqueues for expiring refreshable accounts', async () => {
    const h = setup([
      account({ id: 'expiring', refreshable: true, tokenExpiryAt: h0() + 30 * 60_000 }),
      account({ id: 'far-future', refreshable: true, tokenExpiryAt: h0() + 10 * 3_600_000 }),
      account({ id: 'non-refreshable', refreshable: false, tokenExpiryAt: h0() + 30 * 60_000 }),
      account({ id: 'disabled', refreshable: true, tokenExpiryAt: h0() + 30 * 60_000, enabled: false }),
    ])
    await h.scheduler.tick()
    const jobs = h.store.listJobs('token_refresh')
    expect(jobs.map((j) => j.accountId)).toEqual(['expiring'])
  })

  it('re-scan within the interval does not duplicate enqueues', async () => {
    const h = setup([account({ refreshable: true, tokenExpiryAt: h0() + 1000 })])
    await h.scheduler.tick()
    h.advance(10_000) // within 5min scan interval
    await h.scheduler.tick()
    expect(h.store.listJobs('token_refresh')).toHaveLength(1)
  })

  it('health_check and quota_sync scans cover enabled accounts', async () => {
    const h = setup([account({ id: 'a1' }), account({ id: 'a2', status: 'needs_manual_action' })])
    await h.scheduler.tick()
    expect(h.store.listJobs('health_check')).toHaveLength(2)
    // needs_manual_action accounts are skipped for quota/claims
    expect(h.store.listJobs('quota_sync').map((j) => j.accountId)).toEqual(['a1'])
    // mock provider does not declare supportsCredits -> no credit_claim jobs
    expect(h.store.listJobs('credit_claim')).toHaveLength(0)
  })

  it('credit_claim scan runs every 30 minutes (not once a day)', async () => {
    const h = setup([account({ id: 'a1' })], { supportsCredits: true })
    await h.scheduler.tick()
    expect(h.store.listJobs('credit_claim')).toHaveLength(1)

    h.advance(29 * 60_000)
    await h.scheduler.tick()
    expect(h.store.listJobs('credit_claim')).toHaveLength(1) // still inside the interval

    h.advance(61_000)
    await h.scheduler.tick()
    expect(h.store.listJobs('credit_claim')).toHaveLength(2)
  })

  it('enqueues credit_claim only for providers declaring supportsCredits', async () => {
    const h = setup(
      [account({ id: 'a1' }), account({ id: 'a2', status: 'needs_manual_action' })],
      { supportsCredits: true },
    )
    await h.scheduler.tick()
    expect(h.store.listJobs('credit_claim').map((j) => j.accountId)).toEqual(['a1'])
  })
})

describe('scheduler — execution', () => {
  it('runs due jobs, records results and finishes done', async () => {
    const h = setup([account({ id: 'a1', refreshable: true, tokenExpiryAt: h0() + 1000 })])
    await h.scheduler.tick() // scan enqueues
    // jobs become immediately due (scheduledAt == now)
    await h.scheduler.tick()
    await vi.waitFor(() => {
      expect(h.executed).toContainEqual({ jobType: 'token_refresh', accountId: 'a1' })
    })
    const job = h.store.listJobs('token_refresh')[0]
    expect(job.status).toBe('done')
    expect(JSON.parse(job.resultJson!)).toEqual({ refreshed: true })
  })

  it('retries failed jobs with backoff', async () => {
    const h = setup([account({ id: 'a1' })])
    let attempts = 0
    h.scheduler.setExecutor('quota_sync', async () => {
      attempts++
      throw new UpstreamError({ kind: 'TRANSPORT', message: 'network down' })
    })
    await h.scheduler.tick()
    await vi.waitFor(() => {
      expect(h.store.listJobs('quota_sync').every((j) => j.status === 'pending' && j.error === 'network down')).toBe(true)
    })
    expect(attempts).toBeGreaterThanOrEqual(1)
    const job = h.store.listJobs('quota_sync')[0]
    expect(job.status).toBe('pending')
    expect(job.scheduledAt).toBeGreaterThan(h.now) // backoff scheduled in the future
  })

  it('terminal errors park the account as needs_manual_action', async () => {
    const h = setup([account({ id: 'a1' })])
    h.scheduler.setExecutor('health_check', async () => {
      throw new UpstreamError({ kind: 'TERMINAL', message: 'credential revoked' })
    })
    await h.scheduler.tick()
    await vi.waitFor(() => {
      expect(h.store.listJobs('health_check')[0]?.status).toBe('failed')
    })
    expect(h.store.getAccount('a1')?.account.status).toBe('needs_manual_action')
    const job = h.store.listJobs('health_check')[0]
    expect(job.status).toBe('failed')
    // failed terminal jobs are not rescheduled
    expect(h.store.nextDueJobs('health_check', h.now + 3_600_000)).toHaveLength(0)
  })

  it('cancels jobs for removed accounts and missing executors', async () => {
    const h = setup([account({ id: 'a1' })])
    h.store.removeAccount('a1')
    await h.scheduler.tick() // scan skips removed account; old jobs (none) evaluated
    // manually enqueue a job referencing the removed account
    h.scheduler.enqueue('health_check', 'a1', 'mock')
    await h.scheduler.tick()
    await vi.waitFor(() => {
      expect(h.store.listJobs('health_check')[0]?.status).toBe('cancelled')
    })

    // no executor registered
    const h2 = setup([account({ id: 'b1' })])
    h2.scheduler.setExecutor('quota_sync', undefined as unknown as (job: Parameters<Parameters<typeof h2.scheduler.setExecutor>[1]>[0], account: Account) => Promise<unknown>)
    await h2.scheduler.tick()
    await vi.waitFor(() => {
      expect(h2.store.listJobs('quota_sync')[0]?.status).toBe('cancelled')
    })
  })

  it('manual enqueue is immediately due', async () => {
    const h = setup([account({ id: 'a1' })])
    h.scheduler.enqueue('credit_claim', 'a1', 'mock')
    await h.scheduler.tick()
    await vi.waitFor(() => {
      expect(h.executed).toContainEqual({ jobType: 'credit_claim', accountId: 'a1' })
    })
  })

  it('start/stop lifecycle runs ticks and drains', async () => {
    const h = setup([account({ id: 'a1' })], { tickIntervalMs: 20 })
    h.scheduler.start()
    await vi.waitFor(() => {
      expect(h.store.listJobs().length).toBeGreaterThan(0)
    })
    await h.scheduler.stop()
    expect(h.scheduler['timer']).toBeNull()
  })
})

function h0(): number {
  return 1_700_000_000_000
}
