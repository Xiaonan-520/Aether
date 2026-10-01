import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSqliteStore, SqliteStore } from '../src/store/sqlite/sqlite-store.js'
import { MemoryStore, dayKey } from '../src/store/memory-store.js'
import type { StoreGateway } from '../src/store/types.js'
import type { Account, Job, ModelEntry } from '../src/core/types.js'
import { CredentialCipher } from '../src/store/crypto.js'

const PROVIDER = { id: 'codearts', displayName: 'CodeArts', capabilitiesJson: '{}' }

function seedAccounts(s: SqliteStore, ids: string[]): void {
  for (const id of ids) {
    s.createAccount(account({ id, credentialKey: `CRED_${id}` }))
  }
}

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
    modelRateLimits: { 'deepseek-v4-flash': { resetAtMs: 5_000 } },
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

let dir: string
let store: SqliteStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gateway-db-'))
  const opened = await openSqliteStore(join(dir, 'test.db'))
  if (!opened) throw new Error('better-sqlite3 unavailable')
  store = opened
  store.upsertProviders([PROVIDER])
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('sqlite store', () => {
  it('migrations are idempotent across reopen', async () => {
    const reopened = await openSqliteStore(join(dir, 'test.db'))
    expect(reopened).toBeInstanceOf(SqliteStore)
    reopened!.close()
  })

  it('provider registry upserts and lists', () => {
    store.upsertProviders([{ ...PROVIDER, displayName: 'CodeArts (Huawei)' }])
    expect(store.listProviders()).toEqual([
      { id: 'codearts', displayName: 'CodeArts (Huawei)', capabilitiesJson: '{}', enabled: true },
    ])
  })

  it('account CRUD round-trips all fields', () => {
    expect(store.createAccount(account())).toEqual({ ok: true })
    expect(store.createAccount(account())).toEqual({ ok: false, error: expect.stringContaining('already exists') })

    const got = store.getAccount('codearts-a1b2c3d4')
    expect(got?.account).toMatchObject({
      status: 'active',
      tokenExpiryAt: 1_234,
      refreshable: true,
      modelRateLimits: { 'deepseek-v4-flash': { resetAtMs: 5_000 } },
    })
    expect(store.listAccounts('codearts')).toHaveLength(1)
    expect(store.listAccounts('buddy')).toHaveLength(0)

    store.patchAccount('codearts-a1b2c3d4', {
      status: 'cooldown',
      cooldownUntil: 9_999,
    })
    expect(store.getAccount('codearts-a1b2c3d4')?.account).toMatchObject({
      status: 'cooldown',
      cooldownUntil: 9_999,
      modelRateLimits: { 'deepseek-v4-flash': { resetAtMs: 5_000 } },
    })
    expect(store.patchAccount('missing', { status: 'active' }).ok).toBe(false)

    expect(store.removeAccount('codearts-a1b2c3d4')).toEqual({ ok: true })
    expect(store.getAccount('codearts-a1b2c3d4')).toBeUndefined()
  })

  it('credential blobs survive reopen', async () => {
    const cipher = new CredentialCipher('0123456789abcdef')
    store.setCredential('CRED_A1', cipher.encryptJson({ accessToken: 'tok' }))
    store.close()
    const reopened = (await openSqliteStore(join(dir, 'test.db')))!
    const blob = reopened.getCredential('CRED_A1')
    expect(blob).not.toBeNull()
    expect(cipher.decryptJson<{ accessToken: string }>(blob!).accessToken).toBe('tok')
    reopened.deleteCredential('CRED_A1')
    expect(reopened.getCredential('CRED_A1')).toBeNull()
    reopened.close()
  })

  it('models upsert by (modelId, provider), sorted by priority', () => {
    store.upsertProviders([{ id: 'zcode', displayName: 'ZCode', capabilitiesJson: '{}' }])
    store.upsertModels([modelEntry()])
    store.upsertModels([modelEntry({ priority: 50 })])
    store.upsertModels([modelEntry({ modelId: 'glm-5.3', provider: 'zcode', priority: 99 })])
    const models = store.listModels()
    expect(models).toHaveLength(2)
    expect(models[0].modelId).toBe('glm-5.3')
    expect(models.find((m) => m.modelId === 'deepseek-v4-flash')?.priority).toBe(50)
  })

  it('quota snapshots round-trip', () => {
    seedAccounts(store, ['a1'])
    expect(store.getQuota('a1')).toBeNull()
    store.setQuota('a1', { known: true, remaining: 3, total: 10, resetAt: 5, lastUpdatedAt: 1, rawJson: '{"x":1}' })
    expect(store.getQuota('a1')).toEqual({
      known: true, remaining: 3, total: 10, resetAt: 5, lastUpdatedAt: 1, rawJson: '{"x":1}',
    })
  })

  it('claim idempotency by day key', () => {
    seedAccounts(store, ['a1'])
    const noon = new Date('2026-10-01T12:00:00').getTime()
    store.recordClaim('a1', 'codearts', 'daily', noon, { kind: 'success', credit: 10 })
    expect(store.isClaimedToday('a1', 'daily', dayKey(noon))).toBe(true)
    expect(store.isClaimedToday('a1', 'daily', dayKey(noon + 86_400_000))).toBe(false)
    expect(store.isClaimedToday('a2', 'daily', dayKey(noon))).toBe(false)
  })

  it('job queue semantics match MemoryStore', () => {
    store.createJob(job())
    store.createJob(job({ id: 'j2', scheduledAt: 2_000 }))
    expect(store.nextDueJobs('token_refresh', 1_500)).toHaveLength(1)
    store.updateJob('j1', { status: 'running', startedAt: 1_100 })
    expect(store.nextDueJobs('token_refresh', 2_500)).toHaveLength(1)
    store.updateJob('j1', { status: 'failed', error: 'boom', attempts: 1 })
    expect(store.listJobs('token_refresh').find((j) => j.id === 'j1')?.attempts).toBe(1)
  })

  it('events newest first; settings round-trip', () => {
    store.addEvent({ kind: 'a', ts: 1 })
    store.addEvent({ kind: 'b', ts: 2 })
    expect(store.listEvents(1)[0].kind).toBe('b')
    store.setSetting('tz', 'Asia/Shanghai')
    expect(store.getSetting('tz')).toBe('Asia/Shanghai')
  })

  it('produces the same observable results as MemoryStore (parity check)', () => {
    const parityCases: (s: StoreGateway) => void = (s) => {
      s.upsertProviders?.([{ id: 'codearts', displayName: 'CodeArts', capabilitiesJson: '{}' }])
      s.createAccount(account())
      s.patchAccount('codearts-a1b2c3d4', { status: 'rate_limited' })
      s.upsertModels([modelEntry()])
      s.createJob(job())
    }
    const memory = new MemoryStore()
    parityCases(memory)
    parityCases(store)
    expect(store.listAccounts().map((a) => a.account.status))
      .toEqual(memory.listAccounts().map((a) => a.account.status))
    expect(store.listModels()).toEqual(memory.listModels())
    expect(store.nextDueJobs('token_refresh', 10_000)).toEqual(memory.nextDueJobs('token_refresh', 10_000))
  })
})
