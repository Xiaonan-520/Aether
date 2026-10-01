/**
 * WorkBuddy / CodeBuddy daily check-in (credit claim) tests.
 *
 * All upstream traffic is mocked. The status endpoint is authoritative: the
 * claim endpoint must only be called when the activity is active and today's
 * credit is unclaimed.
 */
import { describe, expect, it, vi } from 'vitest'
import { createWorkBuddyProvider } from '../src/providers/workbuddy/index.js'
import { parseCheckinStatus, claimDailyCheckin, fetchCheckinStatus } from '../src/providers/shared/buddy/credits.js'
import { buildCredential, parseAccountData, parseTokenData } from '../src/providers/shared/buddy/protocol.js'
import { WORKBUDDY } from '../src/providers/shared/buddy/product.js'
import { Scheduler } from '../src/core/worker/scheduler.js'
import { MemoryStore, dayKey } from '../src/store/memory-store.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { registerSchedulerExecutors } from '../src/service/scheduler-executors.js'
import type { Account } from '../src/core/types.js'
import type { ProviderCtx } from '../src/core/registry/provider.js'

const CREDENTIAL = buildCredential(
  parseTokenData({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600, domain: 'www.workbuddy.ai' }),
  parseAccountData({ uid: 'u1', nickname: 'Nina', type: 'personal' }),
)

function account(id = 'workbuddy-a1'): Account {
  return {
    id, provider: 'workbuddy', displayName: id, status: 'active', enabled: true, authenticated: true,
    tokenExpiryAt: null, refreshable: true, credentialKey: 'CRED_WB',
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
}

function ctx(): ProviderCtx {
  return {
    provider: 'workbuddy',
    resolveCredential: async () => ({ ref: 'CRED_WB', expiresAt: null, refreshable: true, credential: CREDENTIAL }),
  }
}

interface Route { match: string; status?: number; json?: unknown }
function fetcherFor(routes: Route[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(route.json ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const ACTIVE_TODAY_UNCLAIMED = { code: 0, msg: 'OK', data: { active: true, today_checked_in: false, daily_credit: 100, streak_days: 3 } }
const ACTIVE_TODAY_CLAIMED = { code: 0, msg: 'OK', data: { active: true, today_checked_in: true, today_credit: 100, streak_days: 3 } }
const INACTIVE = { code: 0, msg: 'OK', data: { active: false, today_checked_in: false, daily_credit: 100 } }

function claimPaths(fetcher: ReturnType<typeof fetcherFor>): string[] {
  return (fetcher as unknown as { mock: { calls: Array<[string]> } }).mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes('daily-checkin'))
}

describe('buddy check-in status parsing', () => {
  it('parses the authoritative status payload', () => {
    expect(parseCheckinStatus(ACTIVE_TODAY_UNCLAIMED)).toMatchObject({
      active: true, todayCheckedIn: false, dailyCredit: 100, streakDays: 3,
    })
  })

  it('returns undefined for a body without data', () => {
    expect(parseCheckinStatus({ code: 0 })).toBeUndefined()
  })

  it('reads status through the credential headers', async () => {
    const fetcher = fetcherFor([{ match: 'checkin-activity-status', json: ACTIVE_TODAY_UNCLAIMED }])
    const status = await fetchCheckinStatus(WORKBUDDY, CREDENTIAL, fetcher)
    expect(status?.active).toBe(true)
    const [url, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect(url).toBe('https://www.workbuddy.ai/v2/billing/meter/checkin-activity-status')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1')
    expect(init.body).toBe('{}')
  })
})

describe('claimDailyCheckin response mapping', () => {
  const call = (route: Route) => claimDailyCheckin(WORKBUDDY, CREDENTIAL, fetcherFor([route]))

  it('maps code 0 to success with the credit amount', async () => {
    const outcome = await call({ match: 'daily-checkin', json: { code: 0, msg: 'OK', data: { credit: 100, streak_days: 3 } } })
    expect(outcome).toMatchObject({ kind: 'success', credit: 100 })
  })

  it('treats code 10001 as already_claimed (not an error)', async () => {
    const outcome = await call({ match: 'daily-checkin', status: 400, json: { code: 10001, msg: '今天已签到，请明天再来' } })
    expect(outcome.kind).toBe('already_claimed')
  })

  it('treats the legacy code 1001 as already_claimed', async () => {
    expect((await call({ match: 'daily-checkin', status: 400, json: { code: 1001 } })).kind).toBe('already_claimed')
  })

  it('maps 1002 / 1003 to not_available', async () => {
    expect((await call({ match: 'daily-checkin', json: { code: 1002 } })).kind).toBe('not_available')
    expect((await call({ match: 'daily-checkin', json: { code: 1003 } })).kind).toBe('not_available')
  })

  it('maps 401 to needs_auth and 403 to needs_manual_action', async () => {
    expect((await call({ match: 'daily-checkin', status: 401, json: {} })).kind).toBe('needs_auth')
    expect((await call({ match: 'daily-checkin', status: 403, json: {} })).kind).toBe('needs_manual_action')
  })

  it('maps an unexpected business code to failed', async () => {
    expect((await call({ match: 'daily-checkin', json: { code: 9999, msg: 'boom' } })).kind).toBe('failed')
  })
})

describe('WorkBuddy ops.claimCredits', () => {
  it('claims when the activity is active and today is unclaimed', async () => {
    const fetcher = fetcherFor([
      { match: 'checkin-activity-status', json: ACTIVE_TODAY_UNCLAIMED },
      { match: 'daily-checkin', json: { code: 0, data: { credit: 100, streak_days: 4 } } },
    ])
    const provider = createWorkBuddyProvider(fetcher)
    const outcome = await provider.ops.claimCredits!(ctx(), account())
    expect(outcome).toMatchObject({ kind: 'success', credit: 100 })
    expect(claimPaths(fetcher)).toHaveLength(1)
  })

  it('returns not_available and NEVER calls daily-checkin when inactive', async () => {
    const fetcher = fetcherFor([{ match: 'checkin-activity-status', json: INACTIVE }])
    const provider = createWorkBuddyProvider(fetcher)
    const outcome = await provider.ops.claimCredits!(ctx(), account())
    expect(outcome.kind).toBe('not_available')
    expect(claimPaths(fetcher)).toHaveLength(0)
  })

  it('returns already_claimed without calling daily-checkin when status says so', async () => {
    const fetcher = fetcherFor([{ match: 'checkin-activity-status', json: ACTIVE_TODAY_CLAIMED }])
    const provider = createWorkBuddyProvider(fetcher)
    const outcome = await provider.ops.claimCredits!(ctx(), account())
    expect(outcome.kind).toBe('already_claimed')
    expect(claimPaths(fetcher)).toHaveLength(0)
  })

  it('fails safely when the status endpoint is unreachable', async () => {
    const fetcher = fetcherFor([]) // every route 404s
    const provider = createWorkBuddyProvider(fetcher)
    const outcome = await provider.ops.claimCredits!(ctx(), account())
    expect(outcome.kind).toBe('failed')
    expect(claimPaths(fetcher)).toHaveLength(0)
  })

  it('declares supportsCredits so the scheduler will schedule it', () => {
    expect(createWorkBuddyProvider().capabilities.supportsCredits).toBe(true)
  })
})

describe('scheduler credit_claim end to end', () => {
  function harness(fetcher: typeof fetch, now = 1_700_000_000_000) {
    const store = new MemoryStore()
    const registry = new ProviderRegistry()
    registry.register(createWorkBuddyProvider(fetcher))
    const acc = account()
    store.createAccount(acc)
    store.setCredential(acc.credentialKey, { ciphertext: Buffer.from(''), iv: Buffer.from(''), tag: Buffer.from('') })
    const state = { now }
    const scheduler = new Scheduler({ store, registry, now: () => state.now, tickIntervalMs: 60_000 })
    registerSchedulerExecutors(scheduler, {
      store,
      registry,
      providerCtx: () => ({
        provider: 'workbuddy',
        resolveCredential: async () => ({ ref: 'CRED_WB', expiresAt: null, refreshable: true, credential: CREDENTIAL }),
      }),
    })
    // tick() dispatches jobs without awaiting, so wait for them to settle.
    async function settle(): Promise<void> {
      for (let i = 0; i < 200; i++) {
        const busy = store.listJobs().some((j) => j.status === 'pending' || j.status === 'running')
        if (!busy) return
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    return { store, scheduler, state, acc, settle }
  }

  it('enqueues and executes a WorkBuddy credit_claim job', async () => {
    const fetcher = fetcherFor([
      { match: 'checkin-activity-status', json: ACTIVE_TODAY_UNCLAIMED },
      { match: 'daily-checkin', json: { code: 0, data: { credit: 100, streak_days: 1 } } },
    ])
    const h = harness(fetcher)
    await h.scheduler.tick()
    await h.settle()
    const jobs = h.store.listJobs('credit_claim')
    expect(jobs).toHaveLength(1)
    expect(jobs[0].status).toBe('done')
    expect(JSON.parse(jobs[0].resultJson!)).toMatchObject({ kind: 'success', credit: 100 })
    expect(claimPaths(fetcher)).toHaveLength(1)
  })

  it('does not claim twice on the same day (no second upstream claim)', async () => {
    const fetcher = fetcherFor([
      { match: 'checkin-activity-status', json: ACTIVE_TODAY_UNCLAIMED },
      { match: 'daily-checkin', json: { code: 0, data: { credit: 100 } } },
    ])
    const h = harness(fetcher)
    await h.scheduler.tick()
    await h.settle()
    expect(claimPaths(fetcher)).toHaveLength(1)

    // same day: manual re-enqueue must be skipped by the store guard
    h.scheduler.enqueue('credit_claim', h.acc.id, 'workbuddy')
    await h.scheduler.tick()
    await h.settle()
    expect(claimPaths(fetcher)).toHaveLength(1)
    const results = h.store.listJobs('credit_claim').map((j) => j.resultJson ?? '')
    expect(results.some((r) => r.includes('already_attempted_today'))).toBe(true)
  })

  it('records the claim in the audit trail and marks the account', async () => {
    const fetcher = fetcherFor([
      { match: 'checkin-activity-status', json: ACTIVE_TODAY_UNCLAIMED },
      { match: 'daily-checkin', json: { code: 0, data: { credit: 100 } } },
    ])
    const h = harness(fetcher)
    await h.scheduler.tick()
    await h.settle()
    expect(h.store.isClaimedToday(h.acc.id, 'credit_claim', dayKey(h.state.now))).toBe(true)
    expect(h.store.getAccount(h.acc.id)?.account.lastCreditClaimAt).toBeTypeOf('number')
  })

  it('inactive does not close the day: the 30-minute poll keeps checking without claiming', async () => {
    const fetcher = fetcherFor([{ match: 'checkin-activity-status', json: INACTIVE }])
    const h = harness(fetcher)
    await h.scheduler.tick()
    await h.settle()
    const statusCalls = () => (fetcher as unknown as { mock: { calls: Array<[string]> } }).mock.calls
      .filter((c) => String(c[0]).includes('checkin-activity-status')).length
    expect(statusCalls()).toBe(1)
    expect(claimPaths(fetcher)).toHaveLength(0)
    // a status-only outcome must not record a claim, so the day stays open
    expect(h.store.isClaimedToday(h.acc.id, 'credit_claim', dayKey(h.state.now))).toBe(false)

    h.scheduler.enqueue('credit_claim', h.acc.id, 'workbuddy')
    await h.scheduler.tick()
    await h.settle()
    expect(statusCalls()).toBe(2)           // polled again
    expect(claimPaths(fetcher)).toHaveLength(0) // still never claims
  })

  it('a failed attempt still closes the day (no retry loop)', async () => {
    const fetcher = fetcherFor([
      { match: 'checkin-activity-status', json: ACTIVE_TODAY_UNCLAIMED },
      { match: 'daily-checkin', json: { code: 9999, msg: 'boom' } },
    ])
    const h = harness(fetcher)
    await h.scheduler.tick()
    await h.settle()
    expect(claimPaths(fetcher)).toHaveLength(1)
    h.scheduler.enqueue('credit_claim', h.acc.id, 'workbuddy')
    await h.scheduler.tick()
    await h.settle()
    expect(claimPaths(fetcher)).toHaveLength(1) // no second attempt today
  })
})

describe('architecture: the scheduler stays provider-agnostic', () => {
  it('scheduler and executors mention no provider or WorkBuddy endpoint', async () => {
    const fs = await import('node:fs')
    const files = ['src/core/worker/scheduler.ts', 'src/service/scheduler-executors.ts']
    const forbidden = [
      'workbuddy', 'codebuddy', 'zcode', 'codearts',
      'checkin-activity-status', 'daily-checkin', 'billing/meter', 'workbuddy.ai',
    ]
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8').toLowerCase()
      for (const needle of forbidden) {
        expect(text.includes(needle), `${file} must not mention "${needle}"`).toBe(false)
      }
    }
  })

  it('the adapter owns the check-status-then-claim decision', async () => {
    const fs = await import('node:fs')
    const adapter = fs.readFileSync('src/providers/shared/buddy/provider.ts', 'utf8')
    // status is read before any claim is attempted
    expect(adapter.indexOf('fetchCheckinStatus')).toBeLessThan(adapter.indexOf('claimDailyCheckin(product'))
  })
})
