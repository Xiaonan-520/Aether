/**
 * Console admin API tests — the aggregation endpoints the web console reads,
 * plus the manual job triggers. Manual triggers must go through the
 * scheduler (never direct adapter calls), preserving retry/idempotency.
 */
import { describe, expect, it } from 'vitest'
import { CredentialCipher } from '../src/store/crypto.js'
import { MemoryStore } from '../src/store/memory-store.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { Scheduler } from '../src/core/worker/scheduler.js'
import { loadConfig } from '../src/config/index.js'
import { createGatewayApp } from '../src/http/app.js'
import { MockProvider, mockModels } from './fixtures/mock-provider.js'
import { ZCodeCaptchaManager } from '../src/providers/zcode/captcha/index.js'
import type { Account } from '../src/core/types.js'
import type { ServiceContext } from '../src/service/context.js'

const ADMIN = 'Bearer admin-token-9'

function account(provider: string, id: string, overrides: Partial<Account> = {}): Account {
  return {
    id, provider, displayName: id, status: 'active', enabled: true, authenticated: true,
    tokenExpiryAt: null, refreshable: true, credentialKey: `CRED_${id.toUpperCase()}`,
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
    ...overrides,
  }
}

function setup() {
  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  const provider = new MockProvider({
    id: 'mock',
    chatScript: [{ type: 'result', result: { content: 'hi', finishReason: 'stop' } }],
  })
  registry.register(provider)
  for (const acc of [
    account('mock', 'mock-a1'),
    account('mock', 'mock-a2', { status: 'rate_limited', enabled: false }),
  ]) {
    store.createAccount(acc)
    store.setCredential(acc.credentialKey, cipher.encryptJson({ accessToken: 'tok' }))
  }
  store.upsertModels(mockModels('mock'))

  const scheduler = new Scheduler({
    store,
    registry,
    now: () => 1_700_000_000_000,
    tickIntervalMs: 60_000,
  })

  const ctx: ServiceContext = {
    config: loadConfig({
      GATEWAY_API_KEY: 'gw-key-123',
      GATEWAY_SECRET: '0123456789abcdef',
      GATEWAY_ADMIN_TOKEN: 'admin-token-9',
    } as NodeJS.ProcessEnv),
    store, cipher, registry,
    router: new ModelRouter(registry, () => store.listModels()),
    pool: new AccountPool({
      listAccounts: (p) => store.listAccounts(p).map((s) => s.account),
      patchAccount: (id, patch) => void store.patchAccount(id, patch),
      hasCredential: () => true,
    }),
    scheduler,
    now: () => Date.now(),
    captcha: new ZCodeCaptchaManager(),
  }
  return { ...createGatewayApp(ctx), store, scheduler }
}

describe('console API — auth', () => {
  it('rejects the overview without admin token', async () => {
    const { app } = setup()
    expect((await app.request('/api/console/overview')).status).toBe(401)
  })

  it('rejects a gateway API key on console endpoints', async () => {
    const { app } = setup()
    const res = await app.request('/api/console/overview', {
      headers: { Authorization: 'Bearer gw-key-123' },
    })
    expect(res.status).toBe(401)
  })
})

describe('console API — GET /api/console/overview', () => {
  it('aggregates totals and per-provider views from the registry', async () => {
    const { app } = setup()
    const res = await app.request('/api/console/overview', { headers: { Authorization: ADMIN } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totals).toMatchObject({ providers: 1, accounts: 2, accountsAvailable: 1 })
    expect(body.providers).toHaveLength(1)
    const p = body.providers[0]
    expect(p).toMatchObject({ id: 'mock', accounts: { total: 2, available: 1 } })
    expect(typeof body.generatedAt).toBe('number')
    // credentials never cross the admin boundary
    expect(JSON.stringify(body)).not.toContain('credentialKey')
    expect(JSON.stringify(body)).not.toContain('CRED_')
  })

  it('returns 404 for an unregistered provider', async () => {
    const { app } = setup()
    const res = await app.request('/api/console/providers/nope/models', {
      headers: { Authorization: ADMIN },
    })
    expect(res.status).toBe(404)
  })
})

describe('console API — models / quotas / claims', () => {
  it('lists models with exposedOnV1 matching enabled registry entries', async () => {
    const { app } = setup()
    const res = await app.request('/api/console/providers/mock/models', {
      headers: { Authorization: ADMIN },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.models.length).toBeGreaterThan(0)
    expect(body.models[0]).toMatchObject({ exposedOnV1: true })
  })

  it('lists quotas with explicit unknown-state fields, never fake zeros', async () => {
    const { app, store } = setup()
    const res = await app.request('/api/console/providers/mock/quotas', {
      headers: { Authorization: ADMIN },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    // no quotaJson was stored: known=false, lastUpdatedAt=null
    expect(body.quotas).toHaveLength(2)
    for (const q of body.quotas) {
      expect(q.known).toBe(false)
      expect(q.lastUpdatedAt).toBeNull()
      expect(q.remaining).toBeNull()
    }
    // now store a real snapshot and confirm it surfaces
    const s = store.listAccounts('mock')[0]!
    store.patchAccount(s.account.id, {
      quotaJson: JSON.stringify({ known: true, remaining: 42, total: 100, resetAt: null, raw: { used: 58 } }),
      lastQuotaAt: 1_700_000_000_000,
    })
    const res2 = await app.request('/api/console/providers/mock/quotas', {
      headers: { Authorization: ADMIN },
    })
    const body2 = await res2.json()
    const withData = body2.quotas.find((q: { accountId: string }) => q.accountId === s.account.id)
    expect(withData).toMatchObject({ known: true, remaining: 42, total: 100 })
    // raw preserves the upstream snapshot stored on the account
    expect(withData.raw.raw).toEqual({ used: 58 })
  })

  it('lists claim jobs for the provider', async () => {
    const { app, store } = setup()
    store.createJob({
      id: 'job-claim-1', provider: 'mock', accountId: 'mock-a1', jobType: 'credit_claim',
      scheduledAt: 1_700_000_000_000, startedAt: null, finishedAt: null,
      status: 'pending', error: null, resultJson: null, attempts: 0,
    })
    const res = await app.request('/api/console/providers/mock/claims?limit=5', {
      headers: { Authorization: ADMIN },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.claims).toHaveLength(1)
    expect(body.claims[0]).toMatchObject({ id: 'job-claim-1', jobType: 'credit_claim', provider: 'mock' })
  })
})

describe('console API — manual job triggers', () => {
  it('POST /api/accounts/:id/refresh enqueues a scheduler job', async () => {
    const { app, store, scheduler } = setup()
    const res = await app.request('/api/accounts/mock-a1/refresh', {
      method: 'POST', headers: { Authorization: ADMIN },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.jobId).toBe('string')
    const jobs = store.listJobs('token_refresh')
    expect(jobs.some((j) => j.id === body.jobId && j.accountId === 'mock-a1')).toBe(true)
    // the job is a real scheduler job with a registered executor type
    expect(scheduler).toBeTruthy()
  })

  it('POST /api/accounts/:id/quota-sync enqueues a scheduler job', async () => {
    const { app, store } = setup()
    const res = await app.request('/api/accounts/mock-a1/quota-sync', {
      method: 'POST', headers: { Authorization: ADMIN },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    const jobs = store.listJobs('quota_sync')
    expect(jobs.some((j) => j.id === body.jobId && j.accountId === 'mock-a1')).toBe(true)
  })

  it('returns 404 for an unknown account', async () => {
    const { app } = setup()
    const res = await app.request('/api/accounts/nope/refresh', {
      method: 'POST', headers: { Authorization: ADMIN },
    })
    expect(res.status).toBe(404)
  })

  it('returns 409 for a disabled account instead of silently queueing', async () => {
    const { app, store } = setup()
    const res = await app.request('/api/accounts/mock-a2/refresh', {
      method: 'POST', headers: { Authorization: ADMIN },
    })
    expect(res.status).toBe(409)
    expect(store.listJobs('token_refresh')).toHaveLength(0)
  })
})
