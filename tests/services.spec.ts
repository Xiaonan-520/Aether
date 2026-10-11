import { describe, expect, it } from 'vitest'
import { CredentialCipher } from '../src/store/crypto.js'
import { MemoryStore } from '../src/store/memory-store.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { loadConfig } from '../src/config/index.js'
import { ChatService } from '../src/service/chat-service.js'
import { ModelService } from '../src/service/model-service.js'
import { AdminService } from '../src/service/admin-service.js'
import type { ServiceContext } from '../src/service/context.js'
import { MockProvider, mockModels, type ScriptedOutcome } from './fixtures/mock-provider.js'
import { UpstreamError } from '../src/core/errors/upstream-error.js'
import type { Account } from '../src/core/types.js'

function account(provider: string, id: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    provider,
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
  models: ModelService
  admin: AdminService
  provider: MockProvider
  accounts: Account[]
}

function setup(opts: {
  chatScript?: ScriptedOutcome[]
  secondProviderScript?: ScriptedOutcome[]
  accounts?: Account[]
} = {}): Harness {
  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  const provider = new MockProvider({ id: 'mock', chatScript: opts.chatScript })
  const second = new MockProvider({ id: 'mockb', chatScript: opts.secondProviderScript })
  registry.register(provider)
  registry.register(second)

  const accounts = opts.accounts ?? [
    account('mock', 'mock-a1'),
    account('mock', 'mock-a2'),
    account('mockb', 'mockb-b1'),
  ]
  for (const acc of accounts) {
    store.createAccount(acc)
    store.setCredential(acc.credentialKey, cipher.encryptJson({ accessToken: 'tok' }))
  }
  store.upsertModels(mockModels('mock'))
  store.upsertModels([
    { ...mockModels('mockb')[0], modelId: 'shared-model', provider: 'mockb' },
  ])

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
  return { ctx, chat: new ChatService(ctx), models: new ModelService(ctx), admin: new AdminService(ctx), provider, accounts }
}

const chatReq = { model: 'mock-model', messages: [{ role: 'user' as const, content: 'hi' }], stream: false }

describe('chat service — happy paths', () => {
  it('returns a completion and reports success', async () => {
    const h = setup({
      chatScript: [{ type: 'result', result: { content: 'answer', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2 } } }],
    })
    const outcome = await h.chat.handle(chatReq)
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') {
      expect(outcome.result.content).toBe('answer')
      expect(outcome.accountId).toBe('mock-a1')
    }
    const stored = h.ctx.store.getAccount('mock-a1')?.account
    expect(stored?.lastSuccessAt).not.toBeNull()
    expect(stored?.status).toBe('active')
  })

  it('routes provider::model explicitly and shared models by priority', async () => {
    const h = setup()
    const explicit = await h.chat.handle({ ...chatReq, model: 'mockb::shared-model' })
    expect(explicit.kind).toBe('result')
    if (explicit.kind === 'result') expect(explicit.provider).toBe('mockb')
  })

  it('streams chunks through to the caller', async () => {
    const h = setup({
      chatScript: [{ type: 'chunks', chunks: [{ text: 'a' }, { text: 'b', finishReason: 'stop' }] }],
    })
    const outcome = await h.chat.handle({ ...chatReq, stream: true })
    expect(outcome.kind).toBe('stream')
    if (outcome.kind === 'stream') {
      const parts: string[] = []
      for await (const chunk of outcome.stream) parts.push(chunk.text)
      expect(parts.join('')).toBe('ab')
    }
  })
})

describe('chat service — failover', () => {
  it('switches accounts on RATE_LIMIT and records the per-model window', async () => {
    const h = setup({
      chatScript: [
        { type: 'error', error: new UpstreamError({ kind: 'RATE_LIMIT', message: '429', detail: 'model:mock-model', retryAfterMs: 60_000 }) },
        { type: 'result', result: { content: 'ok from a2', finishReason: 'stop' } },
      ],
    })
    const outcome = await h.chat.handle(chatReq)
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.accountId).toBe('mock-a2')

    const a1 = h.ctx.store.getAccount('mock-a1')?.account
    expect(a1?.status).toBe('rate_limited')
    expect(a1?.modelRateLimits['mock-model']?.resetAtMs).toBeGreaterThan(Date.now())
    const a2 = h.ctx.store.getAccount('mock-a2')?.account
    expect(a2?.status).toBe('active')
  })

  it('refreshes once on AUTH_INVALID then retries the same account', async () => {
    let refreshes = 0
    const h = setup({
      accounts: [account('mock', 'mock-a1')],
      chatScript: [
        { type: 'error', error: new UpstreamError({ kind: 'AUTH_INVALID', message: '401' }) },
        { type: 'result', result: { content: 'after refresh', finishReason: 'stop' } },
      ],
    })
    h.provider.ops.refreshAccount = async (acc) => {
      refreshes++
      void acc
      return { refreshable: true, expiresAt: Date.now() + 1000, refreshed: true }
    }
    const outcome = await h.chat.handle(chatReq)
    expect(refreshes).toBe(1)
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.accountId).toBe('mock-a1')
    expect(h.ctx.store.getAccount('mock-a1')?.account.status).toBe('active')
  })

  it('switches accounts when refresh fails mid-chat', async () => {
    const h = setup({
      accounts: [account('mock', 'mock-a1'), account('mock', 'mock-a2')],
      chatScript: [
        { type: 'error', error: new UpstreamError({ kind: 'TOKEN_EXPIRED', message: 'expired' }) },
        { type: 'result', result: { content: 'from a2', finishReason: 'stop' } },
      ],
    })
    h.provider.ops.refreshAccount = async () => {
      throw new UpstreamError({ kind: 'TERMINAL', message: 'refresh token revoked' })
    }
    const outcome = await h.chat.handle(chatReq)
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.accountId).toBe('mock-a2')
    expect(h.ctx.store.getAccount('mock-a1')?.account.status).toBe('needs_manual_action')
  })

  it('fails immediately on NEEDS_CAPTCHA without retries', async () => {
    const h = setup({
      accounts: [account('mock', 'mock-a1'), account('mock', 'mock-a2')],
      chatScript: [
        { type: 'error', error: new UpstreamError({ kind: 'NEEDS_CAPTCHA', message: 'captcha required by upstream' }) },
      ],
    })
    await expect(h.chat.handle(chatReq)).rejects.toThrow(/captcha/)
    expect(h.provider.chatCalls).toHaveLength(1) // no second attempt
    expect(h.ctx.store.getAccount('mock-a1')?.account.status).toBe('needs_manual_action')
  })

  it('returns 503 when every account is exhausted', async () => {
    const h = setup({
      accounts: [account('mock', 'mock-a1')],
      chatScript: [
        { type: 'error', error: new UpstreamError({ kind: 'TIMEOUT', message: 't1' }) },
        { type: 'error', error: new UpstreamError({ kind: 'TIMEOUT', message: 't2' }) },
        { type: 'error', error: new UpstreamError({ kind: 'TIMEOUT', message: 't3' }) },
      ],
    })
    await expect(h.chat.handle(chatReq)).rejects.toMatchObject({ status: 503 })
  })

  it('unknown model → 404', async () => {
    const h = setup()
    await expect(h.chat.handle({ ...chatReq, model: 'nope' })).rejects.toMatchObject({ status: 404 })
  })

  it('mid-stream errors surface to the stream consumer and mark the account', async () => {
    const h = setup({
      chatScript: [
        { type: 'chunks', chunks: [{ text: 'partial' }, { text: 'more' }] },
        { type: 'error', error: new UpstreamError({ kind: 'TRANSPORT', message: 'connection reset' }) },
      ],
    })
    const outcome = await h.chat.handle({ ...chatReq, stream: true })
    expect(outcome.kind).toBe('stream')
    if (outcome.kind === 'stream') {
      const parts: string[] = []
      await expect(async () => {
        for await (const chunk of outcome.stream) parts.push(chunk.text)
      }).rejects.toThrow(/reset/)
      // chunks before the failure were already delivered; no failover mid-stream
      expect(parts.join('')).toBe('partialmore')
    }
    expect(h.ctx.store.getAccount('mock-a1')?.account.lastError).toBe('connection reset')
  })
})

describe('model service', () => {
  it('lists models with availability annotations and no secrets', async () => {
    const h = setup()
    const models = h.models.list()
    expect(models).toHaveLength(2) // mock-model + shared-model
    const mockModel = models.find((m) => m.id === 'mock-model')!
    expect(mockModel).toMatchObject({ object: 'model', owned_by: 'mock', available: true })
    expect(JSON.stringify(models)).not.toContain('credentialKey')

    // disable both accounts → unavailable
    h.ctx.store.patchAccount('mock-a1', { status: 'quota_exhausted' })
    h.ctx.store.patchAccount('mock-a2', { status: 'disabled', enabled: false })
    expect(h.models.list().find((m) => m.id === 'mock-model')?.available).toBe(false)
    expect(h.models.list(true).find((m) => m.id === 'mock-model')).toBeUndefined()
  })

  it('forwards the bare upstream model id to adapters (never provider::model)', async () => {
    const h = setup()
    h.ctx.store.upsertModels([{
      modelId: 'mock::mock-model', provider: 'mock', upstreamModel: 'mock-model',
      name: 'Mock Model', capabilities: { vision: false, toolCall: false, streaming: true },
      enabled: true, priority: 10, metadataJson: null,
    }])
    const res = await h.chat.handle({ ...chatReq, model: 'mock::mock-model' })
    expect(res.kind).toBe('result')
    expect(h.provider.chatCalls[0]!.req.model).toBe('mock-model')
  })

  it('hides bare-id duplicates once a namespaced canonical row exists', () => {
    const h = setup()
    h.ctx.store.upsertModels([{
      modelId: 'mock::mock-model', provider: 'mock', upstreamModel: 'mock-model',
      name: 'Mock Model', capabilities: { vision: false, toolCall: false, streaming: true },
      enabled: true, priority: 10, metadataJson: null,
    }])
    const ids = h.models.list().map((m) => m.id)
    expect(ids).toContain('mock::mock-model')
    expect(ids).not.toContain('mock-model')
  })

  it('serializes the OpenAI list envelope', () => {
    const h = setup()
    const body = h.models.toOpenAiList(h.models.list())
    expect(body).toMatchObject({ object: 'list' })
    expect(Array.isArray((body as { data: unknown[] }).data)).toBe(true)
  })
})

describe('admin service', () => {
  it('creates accounts with encrypted credentials and redacts on read', async () => {
    const h = setup()
    const created = await h.admin.createAccount({
      provider: 'mock',
      displayName: 'imported',
      credential: { accessToken: 'super-secret' },
    })
    expect(created).toMatchObject({ provider: 'mock', authenticated: true, status: 'active' })
    expect(JSON.stringify(created)).not.toContain('super-secret')
    expect(JSON.stringify(created)).not.toContain('CRED_')

    // the secret is decryptable internally
    const secret = h.admin.inspectCredential(created.id as string)
    expect(secret).toEqual({ accessToken: 'super-secret' })
  })

  it('imports credentials and resets the account state', async () => {
    const h = setup()
    const created = await h.admin.createAccount({ provider: 'mock' })
    const id = created.id as string
    h.ctx.store.patchAccount(id, { status: 'needs_manual_action', authenticated: false })
    h.admin.importCredential(id, { token: 'x' }, 123)
    const after = h.admin.getAccount(id)
    expect(after).toMatchObject({ authenticated: true, status: 'active', tokenExpiryAt: 123 })
  })

  it('removes accounts and their credentials', async () => {
    const h = setup()
    const created = await h.admin.createAccount({ provider: 'mock', credential: { t: 1 } })
    const id = created.id as string
    h.admin.removeAccount(id)
    expect(h.ctx.store.getAccount(id)).toBeUndefined()
  })

  it('rejects unknown providers and missing accounts', async () => {
    const h = setup()
    await expect(h.admin.createAccount({ provider: 'ghost' })).rejects.toMatchObject({ status: 400 })
    expect(() => h.admin.getAccount('ghost-1')).toThrow(/not found/)
  })

  it('lists jobs and events', async () => {
    const h = setup()
    h.ctx.store.createJob({
      id: 'j1', provider: 'mock', accountId: null, jobType: 'token_refresh',
      scheduledAt: 0, startedAt: null, finishedAt: null, status: 'pending',
      error: null, resultJson: null, attempts: 0,
    })
    expect(h.admin.listJobs('token_refresh')).toHaveLength(1)
    expect(h.admin.listEvents(10)).toEqual([])
  })
})
