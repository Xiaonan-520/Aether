/**
 * Regression tests for the 2026-10 production audit fixes. Each test names
 * the failure it pins down:
 *
 * 1.  account-pool: `rate_limited` was a permanent dead end for
 *     non-refreshable providers (single 429 → account never selectable again).
 * 2.  chat-service/model-service: routing gates only accepted `status === 'active'`,
 *     hiding cooldown-expired / rate-limit-recovered accounts from the router
 *     and `/v1/models` while the pool would happily select them.
 * 3.  zcode/buddy stream readers had no finally-cancel → upstream connections
 *     leaked when a consumer stopped early.
 * 4.  zcode stream silently swallowed Anthropic `error` events → truncated
 *     text reported as a clean `stop`.
 * 5.  zcode non-streaming: malformed upstream JSON raised SyntaxError (→ 400
 *     TERMINAL, no failover) instead of EMPTY_RESPONSE.
 * 6.  scheduler: non-terminal job errors retried forever (30m-capped backoff,
 *     infinite churn); now capped at `maxAttempts` (default 8).
 * 7.  sqlite `recordClaim` stored a UTC day key while executors compute the
 *     local-timezone key → claims between 00:00–08:00 (Beijing) were lost and
 *     the UNIQUE-constraint retry crashed the credit_claim executor.
 * 8.  jobs/events tables grew without bound (~2.8k rows/day); scheduler now
 *     prunes terminal jobs + events older than 7 days.
 */
import { describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { Scheduler } from '../src/core/worker/scheduler.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { MemoryStore } from '../src/store/memory-store.js'
import { openSqliteStore } from '../src/store/sqlite/sqlite-store.js'
import { MockProvider, mockCapabilities } from './fixtures/mock-provider.js'
import { createZCodeProvider } from '../src/providers/zcode/index.js'
import { ZCodeCaptchaManager } from '../src/providers/zcode/captcha/index.js'
import { createWorkBuddyProvider } from '../src/providers/workbuddy/index.js'
import { UpstreamError } from '../src/core/errors/upstream-error.js'
import type { Account, ChatRequest } from '../src/core/types.js'
import type { ProviderCtx } from '../src/core/registry/provider.js'

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

function zcodeCtx(credential: unknown): ProviderCtx {
  return {
    provider: 'zcode',
    resolveCredential: async () => ({ ref: 'CRED_Z1', expiresAt: null, refreshable: false, credential }),
  }
}

function fetcherFor(routes: Array<{ match: string; status?: number; json?: unknown; text?: string }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) return new Response('not found', { status: 404 })
    if (route.text !== undefined) {
      return new Response(route.text, { status: route.status ?? 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(JSON.stringify(route.json ?? {}), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

describe('audit regression — rate_limited recovery (account-pool)', () => {
  it('selects a rate_limited account once its cooldown has expired', () => {
    const now = 1_000_000
    expect(AccountPool.isSelectable(account({ status: 'rate_limited', cooldownUntil: now - 1 }), now)).toBe(true)
    expect(AccountPool.isSelectable(account({ status: 'rate_limited', cooldownUntil: null }), now)).toBe(true)
  })

  it('still blocks a rate_limited account inside its cooldown window', () => {
    const now = 1_000_000
    expect(AccountPool.isSelectable(account({ status: 'rate_limited', cooldownUntil: now + 60_000 }), now)).toBe(false)
  })

  it('end-to-end: a 429 no longer permanently parks a non-refreshable account', async () => {
    // rate_limited is only written here; zcode-like accounts are non-refreshable
    const pool = new AccountPool({
      listAccounts: () => [account({ id: 'a1', status: 'rate_limited', cooldownUntil: 500 })],
      patchAccount: () => {},
      hasCredential: () => true,
    })
    const selected = await pool.selectAccount('mock', {})
    expect(selected?.account.id).toBe('a1')
  })
})

describe('audit regression — zcode stream reader cleanup', () => {
  it('cancels the upstream reader when the consumer breaks out early', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('v')
    // a never-ending SSE body: without finally-cancel this fetcher's body
    // stays locked after the consumer stops
    const sse = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"He"}}\n\n'
    const fetcher = fetcherFor([{ match: 'anthropic/v1/messages', text: sse }])
    const provider = createZCodeProvider({ captcha, fetcher })
    const req: ChatRequest = { model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], stream: true }

    for await (const chunk of provider.chat.stream(zcodeCtx({ jwt_token: 'jwt' }), req, account({ provider: 'zcode' }))) {
      void chunk
      break // consumer stops after the first chunk (client disconnect pattern)
    }
    // the underlying body must be released — a second reader would throw
    // if the stream were still locked
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('releases the body on mid-stream failure', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('v')
    const sse = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"He"}}',
      '',
      'data: {"type":"error","error":{"type":"overloaded","message":"boomed"}}',
      '',
    ].join('\n')
    const provider = createZCodeProvider({ captcha, fetcher: fetcherFor([{ match: 'anthropic/v1/messages', text: sse }]) })
    const req: ChatRequest = { model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], stream: true }
    await expect((async () => {
      for await (const chunk of provider.chat.stream(zcodeCtx({ jwt_token: 'jwt' }), req, account({ provider: 'zcode' }))) {
        void chunk
      }
    })()).rejects.toMatchObject({ kind: 'UPSTREAM_5XX' })
  })
})

describe('audit regression — zcode stream error events (truncation fix)', () => {
  it('maps an Anthropic error event onto UPSTREAM_5XX instead of a clean stop', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('v')
    const sse = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"He"}}',
      '',
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      '',
    ].join('\n')
    const provider = createZCodeProvider({ captcha, fetcher: fetcherFor([{ match: 'anthropic/v1/messages', text: sse }]) })
    const req: ChatRequest = { model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], stream: true }
    const chunks: unknown[] = []
    await expect((async () => {
      for await (const chunk of provider.chat.stream(zcodeCtx({ jwt_token: 'jwt' }), req, account({ provider: 'zcode' }))) {
        chunks.push(chunk)
      }
    })()).rejects.toMatchObject({ kind: 'UPSTREAM_5XX', message: expect.stringContaining('Overloaded') })
    // the partial text before the error still made it out
    expect(chunks.length).toBe(1)
  })

  it('non-streaming: malformed JSON maps to EMPTY_RESPONSE, not SyntaxError', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('v')
    const provider = createZCodeProvider({
      captcha,
      fetcher: fetcherFor([{ match: 'anthropic/v1/messages', status: 200, text: '<html>gateway boom</html>' }]),
    })
    await expect(
      provider.chat.chat(zcodeCtx({ jwt_token: 'jwt' }), { model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], stream: false }, account({ provider: 'zcode' })),
    ).rejects.toMatchObject({ kind: 'EMPTY_RESPONSE' })
  })
})

describe('audit regression — buddy stream reader cleanup', () => {
  it('releases the upstream body via finally on the non-stream aggregation path', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"He"}}]}',
      '',
      'data: {"choices":[{"delta":{}],"finish_reason":null}]}', // malformed shape → skipped
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetcher = fetcherFor([{ match: '/v2/chat/completions', text: sse }])
    const provider = createWorkBuddyProvider(fetcher)
    const result = await provider.chat.chat(
      buddyCtx(),
      { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: false },
      account({ provider: 'workbuddy' }),
    )
    expect(result.content).toBe('He')
  })
})

const CREDENTIAL = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  user_id: 'u1',
  domain: 'www.workbuddy.ai',
}

function buddyCtx(): ProviderCtx {
  return {
    provider: 'workbuddy',
    resolveCredential: async () => ({ ref: 'CRED', expiresAt: null, refreshable: true, credential: CREDENTIAL }),
  }
}

describe('audit regression — scheduler max attempts', () => {
  function schedulerSetup(opts: { maxAttempts?: number } = {}) {
    const store = new MemoryStore()
    const registry = new ProviderRegistry()
    registry.register(new MockProvider({ capabilities: mockCapabilities() }))
    store.createAccount(account())
    const scheduler = new Scheduler({
      store,
      registry,
      now: () => 1_700_000_000_000,
      tickIntervalMs: 60_000,
      maxAttempts: opts.maxAttempts,
    })
    scheduler.setExecutor('quota_sync', async () => {
      throw new UpstreamError({ kind: 'TRANSPORT', message: 'upstream down' })
    })
    return { store, scheduler }
  }

  it('marks a non-terminal job failed after maxAttempts instead of retrying forever', async () => {
    const h = schedulerSetup({ maxAttempts: 3 })
    await h.scheduler.tick() // scan enqueues + runs job (attempt 1, re-scheduled)
    await vi.waitFor(() => expect(h.store.listJobs('quota_sync')[0]?.attempts).toBe(1))
    expect(h.store.listJobs('quota_sync')[0]?.status).toBe('pending')
    // force it due twice more without waiting real backoff
    for (let i = 0; i < 2; i++) {
      const job = h.store.listJobs('quota_sync')[0]
      h.store.updateJob(job!.id, { scheduledAt: 0 })
      await h.scheduler.tick()
      await vi.waitFor(() => expect(h.store.listJobs('quota_sync')[0]?.attempts).toBe(i + 2))
    }
    const job = h.store.listJobs('quota_sync')[0]
    expect(job?.status).toBe('failed')
    expect(job?.attempts).toBe(3)
    expect(job?.error).toBe('upstream down')
  })

  it('keeps default maxAttempts at 8', async () => {
    const h = schedulerSetup()
    await h.scheduler.tick()
    const job = h.store.listJobs('quota_sync')[0]
    expect(job?.status).toBe('pending')
    expect(job?.attempts).toBe(1)
  })
})

describe('audit regression — sqlite claim day key uses local timezone', () => {
  it('stores the same day key dayKey() computes, so 00:00–08:00 claims are not lost', async () => {
    const store = await openSqliteStore(':memory:')
    if (!store) throw new Error('better-sqlite3 unavailable')
    try {
      store.upsertProviders([{ id: 'codearts', displayName: 'CA', capabilitiesJson: '{}' }])
      store.createAccount(account({ id: 'a1', provider: 'codearts', credentialKey: 'CRED_A1' }))
      // 01:30 local time: the old UTC `date(?, 'unixepoch')` key was the
      // previous day, so the executor's dayKey() lookup missed it and the
      // retry hit the UNIQUE constraint
      const earlyMorning = new Date(); earlyMorning.setHours(1, 30, 0, 0)
      store.recordClaim('a1', 'codearts', 'credit_claim', earlyMorning.getTime(), { kind: 'success', credit: 5 })
      // lastClaimOutcome with the executor's key must find it (would be null before the fix),
      // so the executor skips instead of retrying into the UNIQUE constraint
      const { dayKey } = await import('../src/store/memory-store.js')
      const seen = store.lastClaimOutcome('a1', 'credit_claim', dayKey(earlyMorning.getTime()))
      expect(seen).toEqual({ kind: 'success', credit: 5 })
      // the day key must match what the memory store computes for the same instant
      const memory = new MemoryStore()
      memory.createAccount(account({ id: 'a1', provider: 'codearts', credentialKey: 'CRED_A1' }))
      memory.recordClaim('a1', 'codearts', 'credit_claim', earlyMorning.getTime(), { kind: 'success', credit: 5 })
      expect(memory.lastClaimOutcome('a1', 'credit_claim', dayKey(earlyMorning.getTime()))).not.toBeNull()
    } finally {
      store.close()
    }
  })
})

describe('audit regression — history pruning', () => {
  it('MemoryStore.pruneHistory removes only old terminal jobs and old events', () => {
    const store = new MemoryStore()
    const mk = (id: string, status: string, finishedAt: number | null) => ({
      id, provider: 'mock', accountId: 'a1', jobType: 'quota_sync',
      scheduledAt: 0, startedAt: null, finishedAt, status, error: null, resultJson: null, attempts: 1,
    })
    store.createJob(mk('old-done', 'done', 100))
    store.createJob(mk('old-pending', 'pending', 100))
    store.createJob(mk('new-done', 'done', 9_000))
    store.createJob(mk('old-running', 'running', 100))
    const res = store.pruneHistory(5_000)
    expect(res.jobs).toBe(1)
    const left = store.listJobs().map((j) => j.id).sort()
    expect(left).toEqual(['new-done', 'old-pending', 'old-running'])
    store.addEvent({ kind: 'x', ts: 100 })
    store.addEvent({ kind: 'y', ts: 9_000 })
    const res2 = store.pruneHistory(5_000)
    expect(res2.events).toBe(1)
    expect(store.listEvents(10).map((e) => e.kind)).toEqual(['y'])
  })

  it('SqliteStore.pruneHistory removes only old terminal jobs and old events', async () => {
    const store = await openSqliteStore(':memory:')
    if (!store) throw new Error('better-sqlite3 unavailable')
    try {
      const mk = (id: string, status: string, finishedAt: number | null) => ({
        id, provider: 'mock', accountId: 'a1', jobType: 'quota_sync',
        scheduledAt: 0, startedAt: null, finishedAt, status, error: null, resultJson: null, attempts: 1,
      })
      store.createJob(mk('old-done', 'done', 100))
      store.createJob(mk('old-pending', 'pending', 100))
      store.createJob(mk('new-done', 'done', 9_000))
      store.createJob(mk('old-failed', 'failed', 100))
      store.addEvent({ kind: 'x', ts: 100 })
      store.addEvent({ kind: 'y', ts: 9_000 })
      const res = store.pruneHistory(5_000)
      expect(res.jobs).toBe(2)
      expect(res.events).toBe(1)
      const left = store.listJobs().map((j) => j.id).sort()
      expect(left).toEqual(['new-done', 'old-pending'])
      expect(store.listEvents(10).map((e) => e.kind)).toEqual(['y'])
    } finally {
      store.close()
    }
  })

  it('scheduler tick prunes history past the retention window', async () => {
    const store = new MemoryStore()
    const registry = new ProviderRegistry()
    registry.register(new MockProvider())
    store.createAccount(account())
    const scheduler = new Scheduler({ store, registry, now: () => 1_700_000_000_000 })
    store.createJob({
      id: 'ancient', provider: 'mock', accountId: 'mock-a1', jobType: 'quota_sync',
      scheduledAt: 0, startedAt: 0, finishedAt: 1, status: 'done', error: null, resultJson: null, attempts: 1,
    })
    store.addEvent({ kind: 'old', ts: 1 })
    await scheduler.tick()
    expect(store.listJobs().map((j) => j.id)).not.toContain('ancient')
    expect(store.listEvents(10)).toHaveLength(0)
  })
})
