import { describe, expect, it } from 'vitest'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { UpstreamError } from '../src/core/errors/upstream-error.js'
import type { Account } from '../src/core/types.js'

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'codearts-a1',
    provider: 'codearts',
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

class Harness {
  now = 1_000_000
  accounts = new Map<string, Account>()
  refreshCalls: string[] = []
  pool: AccountPool

  constructor(...accounts: Account[]) {
    for (const a of accounts) this.accounts.set(a.id, a)
    this.pool = new AccountPool({
      listAccounts: (provider) =>
        [...this.accounts.values()].filter((a) => a.provider === provider),
      patchAccount: (id, patch) => {
        const current = this.accounts.get(id)
        if (current) this.accounts.set(id, { ...current, ...patch })
      },
      hasCredential: (a) => !a.credentialKey.startsWith('MISSING'),
      refreshAccount: async (a) => {
        this.refreshCalls.push(a.id)
        if (a.id === 'codearts-refresh-dead') {
          throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'refresh rejected' })
        }
        return { ...a, tokenExpiryAt: this.now + 100_000 }
      },
      now: () => this.now,
    })
  }

  tick(ms: number): void {
    this.now += ms
  }

  async select(provider: string, model?: string, exclude?: Set<string>) {
    return this.pool.selectAccount(provider, { model, exclude })
  }
}

describe('account pool — selection', () => {
  it('picks enabled active accounts with credentials', async () => {
    const h = new Harness(
      makeAccount({ id: 'a1' }),
      makeAccount({ id: 'a2', enabled: false }),
      makeAccount({ id: 'a3', status: 'quota_exhausted' }),
      makeAccount({ id: 'a4', credentialKey: 'MISSING_A4' }),
    )
    const picked = await h.select('codearts')
    expect(picked?.account.id).toBe('a1')
  })

  it('skips accounts in per-model rate-limit window, keeps others', async () => {
    const h = new Harness(
      makeAccount({ id: 'a1', modelRateLimits: { m1: { resetAtMs: 2_000_000 } } }),
      makeAccount({ id: 'a2' }),
    )
    const limited = await h.select('codearts', 'm1')
    expect(limited?.account.id).toBe('a2')

    // different model is unaffected
    const other = await h.select('codearts', 'm2')
    expect(other?.account.id).toBe('a1')
  })

  it('rate limit window expiry restores the account (lazy sweep)', async () => {
    const h = new Harness(
      makeAccount({ id: 'a1', modelRateLimits: { m1: { resetAtMs: 900_000 } } }),
    )
    expect((await h.select('codearts', 'm1'))?.account.id).toBe('a1') // resetAt < now
  })

  it('cooldown expiry restores selection', async () => {
    const h = new Harness(makeAccount({ id: 'a1', status: 'cooldown', cooldownUntil: 1_200_000 }))
    expect(await h.select('codearts')).toBeNull()
    h.tick(300_000)
    expect((await h.select('codearts'))?.account.id).toBe('a1')
  })

  it('honors exclude set (failover) and priority metadata', async () => {
    const h = new Harness(
      makeAccount({ id: 'a1', providerMetadataJson: '{"priority":1}' }),
      makeAccount({ id: 'a2', providerMetadataJson: '{"priority":5}' }),
    )
    expect((await h.select('codearts'))?.account.id).toBe('a2')
    expect((await h.select('codearts', undefined, new Set(['a2'])))?.account.id).toBe('a1')
  })

  it('falls back to LRU when priorities are equal', async () => {
    const h = new Harness(
      makeAccount({ id: 'recent', lastSuccessAt: 900_000 }),
      makeAccount({ id: 'stale', lastSuccessAt: 100_000 }),
    )
    expect((await h.select('codearts'))?.account.id).toBe('stale')
  })

  it('returns null when nothing is selectable', async () => {
    const h = new Harness(makeAccount({ id: 'a1', status: 'disabled', enabled: false }))
    expect(await h.select('codearts')).toBeNull()
  })
})

describe('account pool — token refresh during selection', () => {
  it('refreshes expired refreshable tokens inline (single flight)', async () => {
    const h = new Harness(
      makeAccount({ id: 'a1', tokenExpiryAt: 500_000, refreshable: true }),
    )
    const picked = await h.select('codearts')
    expect(h.refreshCalls).toEqual(['a1'])
    expect(picked?.account.tokenExpiryAt).toBeGreaterThan(h.now)
  })

  it('marks refresh failure as auth_failed and moves on', async () => {
    const h = new Harness(
      makeAccount({ id: 'codearts-refresh-dead', tokenExpiryAt: 500_000, refreshable: true }),
      makeAccount({ id: 'a2' }),
    )
    const picked = await h.select('codearts')
    expect(picked?.account.id).toBe('a2')
    expect(h.accounts.get('codearts-refresh-dead')?.status).toBe('auth_failed')
  })

  it('skips expired non-refreshable accounts', async () => {
    const h = new Harness(
      makeAccount({ id: 'a1', tokenExpiryAt: 500_000, refreshable: false }),
    )
    expect(await h.select('codearts')).toBeNull()
  })
})

describe('account pool — reportResult state machine', () => {
  it('success resets failure state', () => {
    const h = new Harness(makeAccount({ id: 'a1', failureCount: 2, status: 'cooldown' }))
    const next = h.pool.reportResult(h.accounts.get('a1')!)
    expect(next).toMatchObject({ status: 'active', failureCount: 0, cooldownUntil: null })
  })

  it('AUTH_INVALID → token_expired', () => {
    const h = new Harness(makeAccount({ id: 'a1' }))
    const next = h.pool.reportResult(
      h.accounts.get('a1')!,
      new UpstreamError({ kind: 'AUTH_INVALID', message: '401' }),
    )
    expect(next.status).toBe('token_expired')
  })

  it('RATE_LIMIT writes per-model window when attribution exists', () => {
    const h = new Harness(makeAccount({ id: 'a1' }))
    const next = h.pool.reportResult(
      h.accounts.get('a1')!,
      new UpstreamError({ kind: 'RATE_LIMIT', message: '429', detail: 'model:m1', retryAfterMs: 120_000 }),
    )
    expect(next.status).toBe('rate_limited')
    expect(next.modelRateLimits['m1']?.resetAtMs).toBe(h.now + 120_000)
    expect(next.cooldownUntil).toBeNull() // model-attributed, no account cooldown
  })

  it('RATE_LIMIT without model attribution cools the whole account', () => {
    const h = new Harness(makeAccount({ id: 'a1' }))
    const next = h.pool.reportResult(
      h.accounts.get('a1')!,
      new UpstreamError({ kind: 'RATE_LIMIT', message: '429', retryAfterMs: 60_000 }),
    )
    expect(next.status).toBe('rate_limited')
    expect(next.cooldownUntil).toBe(h.now + 60_000)
  })

  it('QUOTA_EXHAUSTED parks the account', () => {
    const h = new Harness(makeAccount({ id: 'a1' }))
    const next = h.pool.reportResult(
      h.accounts.get('a1')!,
      new UpstreamError({ kind: 'QUOTA_EXHAUSTED', message: 'balance empty' }),
    )
    expect(next.status).toBe('quota_exhausted')
    expect(AccountPool.isSelectable(next, h.now)).toBe(false)
  })

  it('NEEDS_CAPTCHA / NEEDS_MANUAL → needs_manual_action, never auto-retried', () => {
    const h = new Harness(makeAccount({ id: 'a1' }))
    const next = h.pool.reportResult(
      h.accounts.get('a1')!,
      new UpstreamError({ kind: 'NEEDS_CAPTCHA', message: 'captcha required' }),
    )
    expect(next.status).toBe('needs_manual_action')
    expect(next.quotaManualRequired).toBe(true)
    expect(AccountPool.isSelectable(next, h.now)).toBe(false)
  })

  it('TERMINAL records but does not poison the account', () => {
    const h = new Harness(makeAccount({ id: 'a1' }))
    const next = h.pool.reportResult(
      h.accounts.get('a1')!,
      new UpstreamError({ kind: 'TERMINAL', message: 'bad request' }),
    )
    expect(next.status).toBe('active')
    expect(next.lastError).toBe('bad request')
  })

  it('transport failures accumulate into exponential cooldown', () => {
    const h = new Harness(makeAccount({ id: 'a1' }))
    const timeout = () => new UpstreamError({ kind: 'TIMEOUT', message: 'idle timeout' })
    const after1 = h.pool.reportResult(h.accounts.get('a1')!, timeout())
    expect(after1.status).toBe('active')
    const after2 = h.pool.reportResult(after1, timeout())
    expect(after2.status).toBe('active')
    const after3 = h.pool.reportResult(after2, timeout())
    expect(after3.status).toBe('cooldown')
    expect(after3.cooldownUntil).toBe(h.now + 60_000)

    // next round: failureCount keeps growing (4→5→6) so backoff = 60s * 2^(6-3) = 480s
    h.accounts.set('a1', after3)
    h.tick(60_000) // let the cooldown expire to become selectable again
    const round2a = h.pool.reportResult(h.accounts.get('a1')!, timeout())
    const round2b = h.pool.reportResult(round2a, timeout())
    const round2c = h.pool.reportResult(round2b, timeout())
    expect(round2c.cooldownUntil).toBe(h.now + 480_000)
  })
})

describe('account pool — concurrent report consistency', () => {
  it('counts failures from stale snapshots instead of losing them', () => {
    const h = new Harness(makeAccount({ id: 'a1' }))
    const stale = h.accounts.get('a1')!
    const timeout = () => new UpstreamError({ kind: 'TIMEOUT', message: 'idle timeout' })

    // Simulate three in-flight requests that all captured the same account
    // snapshot before any of them reported back.
    const after1 = h.pool.reportResult(stale, timeout())
    const after2 = h.pool.reportResult(stale, timeout())
    const after3 = h.pool.reportResult(stale, timeout())

    expect(after1.failureCount).toBe(1)
    expect(after2.failureCount).toBe(2)
    expect(after3.failureCount).toBe(3)
    expect(after3.status).toBe('cooldown')
    expect(after3.cooldownUntil).toBe(h.now + 60_000)
  })
})
