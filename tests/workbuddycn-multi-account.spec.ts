/**
 * WorkBuddyCN multi-account routing at the Core seam (simulated accounts).
 *
 * Uses the real ChatService + AccountPool + Remote-provider-shaped account
 * records, with a scripted provider so no upstream or production credential is
 * involved. These tests pin:
 *  - each account is addressed independently (selected account id reaches the
 *    provider call);
 *  - priority and LRU selection;
 *  - failover on rate limit / quota exhaustion / auth failure;
 *  - cooldown prevents reusing a rate-limited account;
 *  - all accounts unavailable fails closed (no blind retry).
 */
import { describe, expect, it, vi } from 'vitest'
import { CredentialCipher } from '../src/store/crypto.js'
import { MemoryStore } from '../src/store/memory-store.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { loadConfig } from '../src/config/index.js'
import { ChatService } from '../src/service/chat-service.js'
import { registerSchedulerExecutors } from '../src/service/scheduler-executors.js'
import { Scheduler } from '../src/core/worker/scheduler.js'
import type { ServiceContext } from '../src/service/context.js'
import { MockProvider, mockModels, type ScriptedOutcome } from './fixtures/mock-provider.js'
import { UpstreamError } from '../src/core/errors/upstream-error.js'
import type { Account } from '../src/core/types.js'

const PROVIDER = 'workbuddycn'

function account(id: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    provider: PROVIDER,
    displayName: id,
    status: 'active',
    enabled: true,
    authenticated: true,
    tokenExpiryAt: null,
    refreshable: true,
    credentialKey: `CRED_${id.toUpperCase()}`,
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
  ctx: ServiceContext
  chat: ChatService
  provider: MockProvider
}

function setup(opts: {
  accounts?: Account[]
  chatScript?: ScriptedOutcome[]
  refresh?: (a: Account) => Promise<{ refreshable: boolean; expiresAt: number | null; refreshed: boolean; error?: string }>
} = {}): Harness {
  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  const provider = new MockProvider({
    id: PROVIDER,
    chatScript: opts.chatScript,
    refresh: opts.refresh,
  })
  registry.register(provider)

  const accounts = opts.accounts ?? [account('workbuddycn-a1'), account('workbuddycn-a2')]
  for (const acc of accounts) {
    store.createAccount(acc)
    store.setCredential(acc.credentialKey, cipher.encryptJson({ storedInExtension: true }))
  }
  store.upsertModels(mockModels(PROVIDER))

  const ctx: ServiceContext = {
    config: loadConfig({
      GATEWAY_API_KEY: 'k',
      GATEWAY_SECRET: '0123456789abcdef',
      GATEWAY_ADMIN_TOKEN: 'a',
    } as NodeJS.ProcessEnv),
    store,
    cipher,
    registry,
    router: new ModelRouter(registry, () => store.listModels()),
    pool: new AccountPool({
      listAccounts: (p) => store.listAccounts(p).map((s) => s.account),
      patchAccount: (id, patch) => void store.patchAccount(id, patch),
      hasCredential: () => true,
    }),
    now: () => Date.now(),
  }
  return { ctx, chat: new ChatService(ctx), provider }
}

const chatReq = {
  model: 'mock-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  stream: false,
}

function result(content: string): ScriptedOutcome {
  return { type: 'result', result: { content, finishReason: 'stop' } }
}

function upstreamError(kind: 'RATE_LIMIT' | 'QUOTA_EXHAUSTED' | 'AUTH_INVALID' | 'TIMEOUT'): ScriptedOutcome {
  return { type: 'error', error: new UpstreamError({ kind, message: kind.toLowerCase() }) }
}

describe('WorkBuddyCN multi-account selection', () => {
  it('routes the first request to the first account and the next to the LRU account', async () => {
    const h = setup({ chatScript: [result('a1'), result('a2')] })
    const first = await h.chat.handle(chatReq)
    const second = await h.chat.handle(chatReq)
    expect(first.kind).toBe('result')
    expect(second.kind).toBe('result')
    if (first.kind === 'result') expect(first.accountId).toBe('workbuddycn-a1')
    if (second.kind === 'result') expect(second.accountId).toBe('workbuddycn-a2')
    expect(h.provider.chatCalls.map((c) => c.accountId)).toEqual(['workbuddycn-a1', 'workbuddycn-a2'])
  })

  it('honors account priority before LRU', async () => {
    const h = setup({
      accounts: [
        account('workbuddycn-a1', { providerMetadataJson: '{"priority":1}' }),
        account('workbuddycn-a2', { providerMetadataJson: '{"priority":5}' }),
      ],
      chatScript: [result('a2')],
    })
    const outcome = await h.chat.handle(chatReq)
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.accountId).toBe('workbuddycn-a2')
  })

  it('prefers a healthy account over a just-recovered rate-limited account', async () => {
    const h = setup({
      accounts: [
        account('workbuddycn-a1', {
          status: 'rate_limited',
          cooldownUntil: 1,
          lastSuccessAt: 0,
        }),
        account('workbuddycn-a2', { status: 'active', lastSuccessAt: 1_000 }),
      ],
      chatScript: [result('a2')],
    })
    const outcome = await h.chat.handle(chatReq)
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.accountId).toBe('workbuddycn-a2')
    expect(h.provider.chatCalls.map((c) => c.accountId)).toEqual(['workbuddycn-a2'])
  })

  it('concurrent requests may select the same account (no lease/stickiness)', async () => {
    const h = setup({ chatScript: [result('one'), result('two')] })
    const [a, b] = await Promise.all([h.chat.handle(chatReq), h.chat.handle(chatReq)])
    expect(a.kind).toBe('result')
    expect(b.kind).toBe('result')
    expect(h.provider.chatCalls).toHaveLength(2)
    expect(h.provider.chatCalls.map((c) => c.accountId)).toEqual(['workbuddycn-a1', 'workbuddycn-a1'])
  })
})

describe('WorkBuddyCN multi-account failover', () => {
  it('switches to the next account on an account-level rate limit and cools the first', async () => {
    const h = setup({ chatScript: [upstreamError('RATE_LIMIT'), result('a2')] })
    const outcome = await h.chat.handle(chatReq)
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.accountId).toBe('workbuddycn-a2')

    const a1 = h.ctx.store.getAccount('workbuddycn-a1')!.account
    expect(a1.status).toBe('rate_limited')
    expect(a1.cooldownUntil).not.toBeNull()
    expect(a1.cooldownUntil!).toBeGreaterThan(Date.now())
  })

  it('parks a quota-exhausted account and switches without retrying it', async () => {
    const h = setup({ chatScript: [upstreamError('QUOTA_EXHAUSTED'), result('a2')] })
    const outcome = await h.chat.handle(chatReq)
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.accountId).toBe('workbuddycn-a2')

    const a1 = h.ctx.store.getAccount('workbuddycn-a1')!.account
    expect(a1.status).toBe('quota_exhausted')
    expect(AccountPool.isSelectable(a1, Date.now())).toBe(false)
    expect(h.provider.chatCalls.map((c) => c.accountId)).toEqual(['workbuddycn-a1', 'workbuddycn-a2'])
  })

  it('refreshes once on auth failure and retries the same account', async () => {
    let refreshes = 0
    const h = setup({
      accounts: [account('workbuddycn-a1')],
      chatScript: [upstreamError('AUTH_INVALID'), result('after-refresh')],
      refresh: async () => {
        refreshes += 1
        return { refreshable: true, expiresAt: Date.now() + 60_000, refreshed: true }
      },
    })
    const outcome = await h.chat.handle(chatReq)
    expect(refreshes).toBe(1)
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.accountId).toBe('workbuddycn-a1')
    expect(h.ctx.store.getAccount('workbuddycn-a1')!.account.status).toBe('active')
  })

  it('switches accounts when refresh fails terminally', async () => {
    const h = setup({
      accounts: [account('workbuddycn-a1'), account('workbuddycn-a2')],
      chatScript: [upstreamError('AUTH_INVALID'), result('a2')],
      refresh: async () => {
        throw new UpstreamError({ kind: 'TERMINAL', message: 'refresh token revoked' })
      },
    })
    const outcome = await h.chat.handle(chatReq)
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.accountId).toBe('workbuddycn-a2')
    expect(h.ctx.store.getAccount('workbuddycn-a1')!.account.status).toBe('needs_manual_action')
  })

  it('does not reuse rate-limited accounts: a second request fails closed', async () => {
    const h = setup({ chatScript: [upstreamError('RATE_LIMIT'), upstreamError('RATE_LIMIT')] })
    await expect(h.chat.handle(chatReq)).rejects.toMatchObject({ status: 429 })
    expect(h.provider.chatCalls.map((c) => c.accountId)).toEqual(['workbuddycn-a1', 'workbuddycn-a2'])

    // Both cooldowns are active; selection must return null, not hammer either.
    // As above, Core currently filters the model before the 503 path when no
    // account is usable, so the second request is a 404 — the important part is
    // that neither cooled account was called again.
    await expect(h.chat.handle(chatReq)).rejects.toMatchObject({ status: 404 })
    expect(h.provider.chatCalls).toHaveLength(2)
  })

  it('fails without calling upstream when every account is already unavailable', async () => {
    const h = setup({
      accounts: [
        account('workbuddycn-a1', { status: 'quota_exhausted' }),
        account('workbuddycn-a2', { status: 'disabled', enabled: false }),
      ],
    })
    // Current Core behavior: the model is filtered from routing when no account
    // is usable, so the request fails as "model not found". The 503 branch in
    // toClientError is only reachable after attempts have parked every account.
    // This is recorded as a semantic gap, not changed here (public API status).
    await expect(h.chat.handle(chatReq)).rejects.toMatchObject({ status: 404 })
    expect(h.provider.chatCalls).toHaveLength(0)
  })
})

describe('WorkBuddyCN per-account quota refresh', () => {
  it('runs quota_sync for both accounts and stores separate snapshots', async () => {
    const h = setup({
      accounts: [account('workbuddycn-a1'), account('workbuddycn-a2')],
    })
    h.provider.quotaFn = async (a) => ({
      known: true,
      remaining: a.id.endsWith('a1') ? 10 : 20,
      total: 100,
      resetAt: null,
      lastUpdatedAt: Date.now(),
      rawJson: JSON.stringify({ accountId: a.id }),
    })

    const scheduler = new Scheduler({
      store: h.ctx.store,
      registry: h.ctx.registry,
      maxConcurrent: 2,
    })
    registerSchedulerExecutors(scheduler, {
      store: h.ctx.store,
      registry: h.ctx.registry,
      providerCtx: () => ({ provider: PROVIDER, resolveCredential: async () => undefined }),
    })

    await scheduler.tick()
    await vi.waitFor(() => {
      const done = h.ctx.store.listJobs('quota_sync').filter((j) => j.status === 'done')
      expect(done).toHaveLength(2)
    })

    const a1 = h.ctx.store.getAccount('workbuddycn-a1')!.account
    const a2 = h.ctx.store.getAccount('workbuddycn-a2')!.account
    expect(a1.lastQuotaAt).not.toBeNull()
    expect(a2.lastQuotaAt).not.toBeNull()
    expect(a1.quotaJson).toContain('workbuddycn-a1')
    expect(a2.quotaJson).toContain('workbuddycn-a2')
    expect(a1.quotaJson).not.toBe(a2.quotaJson)
  })
})
