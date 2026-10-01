import { describe, expect, it } from 'vitest'
import { MemoryStore, dayKey } from '../src/store/memory-store.js'
import type { Account, Job, ModelEntry } from '../src/core/types.js'
import { CredentialCipher } from '../src/store/crypto.js'

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'codearts-a1b2c3d4',
    provider: 'codearts',
    displayName: 'test account',
    status: 'active',
    enabled: true,
    authenticated: true,
    tokenExpiryAt: 1_234,
    refreshable: true,
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
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    provider: 'codearts',
    accountId: 'codearts-a1b2c3d4',
    jobType: 'token_refresh',
    scheduledAt: 1_000,
    startedAt: null,
    finishedAt: null,
    status: 'pending',
    error: null,
    resultJson: null,
    attempts: 0,
    ...overrides,
  }
}

function modelEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    modelId: 'deepseek-v4-flash',
    provider: 'codearts',
    upstreamModel: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    capabilities: { vision: false, toolCall: true, streaming: true },
    enabled: true,
    priority: 10,
    metadataJson: null,
    ...overrides,
  }
}

describe('memory store — accounts', () => {
  it('creates, lists, gets and patches accounts', () => {
    const store = new MemoryStore()
    expect(store.createAccount(account())).toEqual({ ok: true })
    expect(store.createAccount(account())).toEqual({ ok: false, error: expect.stringContaining('already exists') })

    expect(store.listAccounts()).toHaveLength(1)
    expect(store.listAccounts('codearts')).toHaveLength(1)
    expect(store.listAccounts('buddy')).toHaveLength(0)
    expect(store.getAccount('codearts-a1b2c3d4')?.account.displayName).toBe('test account')
    expect(store.getAccount('missing')).toBeUndefined()

    expect(store.patchAccount('codearts-a1b2c3d4', { status: 'cooldown' })).toEqual({ ok: true })
    expect(store.getAccount('codearts-a1b2c3d4')?.account.status).toBe('cooldown')
    expect(store.patchAccount('missing', { status: 'active' }).ok).toBe(false)
  })

  it('removes accounts and their quota snapshot', () => {
    const store = new MemoryStore()
    store.createAccount(account())
    store.setQuota('codearts-a1b2c3d4', { known: true, remaining: 5, total: 10, resetAt: null, lastUpdatedAt: 1, rawJson: null })
    expect(store.removeAccount('codearts-a1b2c3d4')).toEqual({ ok: true })
    expect(store.removeAccount('codearts-a1b2c3d4').ok).toBe(false)
    expect(store.getQuota('codearts-a1b2c3d4')).toBeNull()
  })
})

describe('memory store — credentials', () => {
  it('stores and deletes encrypted blobs', () => {
    const store = new MemoryStore()
    const cipher = new CredentialCipher('0123456789abcdef')
    const blob = cipher.encryptJson({ accessToken: 'tok' })
    store.setCredential('CRED_A1', blob)
    const round = store.getCredential('CRED_A1')
    expect(round).not.toBeNull()
    expect(cipher.decryptJson<{ accessToken: string }>(round!).accessToken).toBe('tok')

    store.deleteCredential('CRED_A1')
    expect(store.getCredential('CRED_A1')).toBeNull()
  })
})

describe('memory store — models', () => {
  it('upserts by (modelId, provider) and lists entries', () => {
    const store = new MemoryStore()
    store.upsertModels([modelEntry()])
    store.upsertModels([modelEntry({ priority: 20 })])
    store.upsertModels([modelEntry({ modelId: 'other', provider: 'codearts' })])
    store.upsertModels([modelEntry({ modelId: 'deepseek-v4-flash', provider: 'buddy' })])

    expect(store.listModels()).toHaveLength(3)
    const hit = store.listModels().find((m) => m.modelId === 'deepseek-v4-flash' && m.provider === 'codearts')
    expect(hit?.priority).toBe(20)
  })
})

describe('memory store — quotas and claims', () => {
  it('stores quota snapshots', () => {
    const store = new MemoryStore()
    expect(store.getQuota('a1')).toBeNull()
    store.setQuota('a1', { known: true, remaining: 3, total: 10, resetAt: 5, lastUpdatedAt: 1, rawJson: '{"x":1}' })
    expect(store.getQuota('a1')?.remaining).toBe(3)
  })

  it('claim idempotency by day key', () => {
    const store = new MemoryStore()
    const noon = new Date('2026-10-01T12:00:00').getTime()
    store.recordClaim('a1', 'codearts', 'daily', noon, { kind: 'success', credit: 10 })
    expect(store.isClaimedToday('a1', 'daily', dayKey(noon))).toBe(true)
    expect(store.isClaimedToday('a1', 'daily', dayKey(noon + 86_400_000))).toBe(false)
    expect(store.isClaimedToday('a2', 'daily', dayKey(noon))).toBe(false)
    expect(store.isClaimedToday('a1', 'onboarding', dayKey(noon))).toBe(false)
  })
})

describe('memory store — jobs', () => {
  it('create/update/list/nextDue', () => {
    const store = new MemoryStore()
    store.createJob(job())
    store.createJob(job({ id: 'j2', scheduledAt: 2_000 }))

    expect(store.listJobs()).toHaveLength(2)
    expect(store.listJobs('token_refresh')).toHaveLength(2)
    expect(store.listJobs('quota_sync')).toHaveLength(0)

    expect(store.nextDueJobs('token_refresh', 1_500)).toHaveLength(1)
    expect(store.nextDueJobs('token_refresh', 2_500)).toHaveLength(2)

    store.updateJob('j1', { status: 'running', startedAt: 1_100 })
    expect(store.nextDueJobs('token_refresh', 2_500)).toHaveLength(1) // j1 no longer pending

    store.updateJob('j1', { status: 'failed', error: 'boom', attempts: 1 })
    expect(store.listJobs('token_refresh').find((j) => j.id === 'j1')?.status).toBe('failed')

    store.updateJob('missing', { status: 'done' }) // no throw
  })
})

describe('memory store — events and settings', () => {
  it('events return newest first, limited', () => {
    const store = new MemoryStore()
    store.addEvent({ kind: 'a' })
    store.addEvent({ kind: 'b' })
    store.addEvent({ kind: 'c' })
    expect(store.listEvents(2).map((e) => e.kind)).toEqual(['c', 'b'])
  })

  it('settings round-trip', () => {
    const store = new MemoryStore()
    expect(store.getSetting('tz')).toBeUndefined()
    store.setSetting('tz', 'Asia/Shanghai')
    expect(store.getSetting('tz')).toBe('Asia/Shanghai')
  })
})
