import { describe, expect, it } from 'vitest'
import { CredentialCipher } from '../src/store/crypto.js'
import { MemoryStore } from '../src/store/memory-store.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { loadConfig } from '../src/config/index.js'
import { createGatewayApp } from '../src/http/app.js'
import { MockProvider, mockModels } from './fixtures/mock-provider.js'
import { ZCodeCaptchaManager } from '../src/providers/zcode/captcha/index.js'
import { UpstreamError } from '../src/core/errors/upstream-error.js'
import type { Account, ServiceContextLike } from '../src/core/types.js'
import type { ServiceContext } from '../src/service/context.js'

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

function setup(chatScript?: Parameters<typeof MockProvider.prototype['chat']['chat'] extends never ? never : never> | never) {
  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  const provider = new MockProvider({
    id: 'mock',
    chatScript: chatScript ?? [
      { type: 'result', result: { content: 'hello from mock', finishReason: 'stop' } },
    ],
  })
  registry.register(provider)
  for (const acc of [account('mock', 'mock-a1'), account('mock', 'mock-a2')]) {
    store.createAccount(acc)
    store.setCredential(acc.credentialKey, cipher.encryptJson({ accessToken: 'tok' }))
  }
  store.upsertModels(mockModels('mock'))
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
    now: () => Date.now(),
    captcha: new ZCodeCaptchaManager(),
  }
  return { ...createGatewayApp(ctx), store, provider }
}

describe('http — health and auth', () => {
  it('GET /healthz without auth', async () => {
    const { app } = setup()
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('rejects /v1 without or with wrong bearer', async () => {
    const { app } = setup()
    expect((await app.request('/v1/models')).status).toBe(401)
    const bad = await app.request('/v1/models', { headers: { Authorization: 'Bearer wrong' } })
    expect(bad.status).toBe(401)
    const body = await bad.json()
    expect(body.error.type).toBe('authentication_error')
  })

  it('rejects /api without admin token', async () => {
    const { app } = setup()
    const res = await app.request('/api/accounts', {
      headers: { Authorization: 'Bearer gw-key-123' }, // gateway key is not the admin token
    })
    expect(res.status).toBe(401)
  })
})

describe('http — /v1/models', () => {
  it('lists models in OpenAI envelope', async () => {
    const { app } = setup()
    const res = await app.request('/v1/models', { headers: { Authorization: 'Bearer gw-key-123' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.object).toBe('list')
    expect(body.data[0]).toMatchObject({ id: 'mock-model', owned_by: 'mock', object: 'model' })
    expect(JSON.stringify(body)).not.toContain('credential')
  })

  it('POST /api/providers/:id/sync-models re-syncs from the live adapter', async () => {
    const { app, store, provider } = setup()
    provider.models = [{
      modelId: 'mock::fresh-model', provider: 'mock', upstreamModel: 'fresh-model',
      name: 'Fresh', capabilities: { vision: false, toolCall: false, streaming: true },
      enabled: true, priority: 10, metadataJson: null,
    }]
    const res = await app.request('/api/providers/mock/sync-models', {
      method: 'POST', headers: { Authorization: 'Bearer admin-token-9' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ provider: 'mock', models_synced: 1 })
    expect(store.listModels().some((m) => m.modelId === 'mock::fresh-model')).toBe(true)
  })

  it('POST /api/providers/:id/sync-models → 409 without an authenticated account', async () => {
    const { app, store } = setup()
    for (const s of store.listAccounts('mock')) store.patchAccount(s.account.id, { authenticated: false })
    const res = await app.request('/api/providers/mock/sync-models', {
      method: 'POST', headers: { Authorization: 'Bearer admin-token-9' },
    })
    expect(res.status).toBe(409)
  })
})

describe('http — /v1/chat/completions', () => {
  const headers = {
    Authorization: 'Bearer gw-key-123',
    'Content-Type': 'application/json',
  }

  it('non-streaming completion', async () => {
    const { app } = setup()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'hello from mock' }, finish_reason: 'stop' }],
    })
  })

  it('streaming: SSE frames, [DONE] terminator, correct content type', async () => {
    const { app } = setup([
      { type: 'chunks', chunks: [{ text: 'he' }, { text: 'y', finishReason: 'stop' }] },
    ])
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    const frames = text.split('\n\n').filter(Boolean)
    expect(frames.at(-1)).toBe('data: [DONE]')
    const parsed = frames.slice(0, -1).map((f) => JSON.parse(f.slice(6)))
    expect(parsed).toHaveLength(2)
    expect(parsed[0].object).toBe('chat.completion.chunk')
    expect(parsed[0].choices[0].delta.content).toBe('he')
    expect(parsed[1].choices[0].delta.content).toBe('y')
    expect(parsed[1].choices[0].finish_reason).toBe('stop')
  })

  it('streaming: first-chunk failure fails over before SSE is committed', async () => {
    const { app, store } = setup([
      { type: 'error', error: new UpstreamError({ kind: 'RATE_LIMIT', message: '429' }) },
      { type: 'chunks', chunks: [{ text: 'from b', finishReason: 'stop' }] },
    ])
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('from b')
    expect(store.getAccount('mock-a1')?.account.status).toBe('rate_limited')
  })

  it('streaming: all accounts failing before the first chunk returns HTTP 429, not SSE', async () => {
    const { app } = setup([
      { type: 'error', error: new UpstreamError({ kind: 'RATE_LIMIT', message: '429-a' }) },
      { type: 'error', error: new UpstreamError({ kind: 'RATE_LIMIT', message: '429-b' }) },
    ])
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.status).toBe(429)
    expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream')
  })

  it('failover across accounts inside one request (429 then success)', async () => {
    const { app, store } = setup([
      { type: 'error', error: new UpstreamError({ kind: 'RATE_LIMIT', message: '429', detail: 'model:mock-model' }) },
      { type: 'result', result: { content: 'from a2', finishReason: 'stop' } },
    ])
    const res = await app.request('/v1/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).choices[0].message.content).toBe('from a2')
    expect(store.getAccount('mock-a1')?.account.status).toBe('rate_limited')
  })

  it('400 for invalid request body, OpenAI error shape', async () => {
    const { app } = setup()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST', headers, body: JSON.stringify({ model: 'mock-model', messages: 'nope' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('404 for unknown model', async () => {
    const { app } = setup()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'ghost', messages: [{ role: 'user', content: 'x' }] }),
    })
    expect(res.status).toBe(404)
  })

  it('503 with OpenAI error body when no account is available', async () => {
    const { app, store } = setup([
      { type: 'error', error: new UpstreamError({ kind: 'NEEDS_CAPTCHA', message: 'captcha needed' }) },
    ])
    store.patchAccount('mock-a2', { enabled: false })
    const res = await app.request('/v1/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.type).toBe('upstream_error')
  })
})

describe('http — /api admin', () => {
  const adminHeaders = { Authorization: 'Bearer admin-token-9', 'Content-Type': 'application/json' }

  it('account CRUD round trip', async () => {
    const { app } = setup()
    const created = await app.request('/api/accounts', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ provider: 'mock', displayName: 'via api', credential: { token: 'x' } }),
    })
    expect(created.status).toBe(201)
    const accountBody = await created.json()
    expect(accountBody.displayName).toBe('via api')

    const listed = await app.request('/api/accounts', { headers: adminHeaders })
    expect(((await listed.json()).accounts as unknown[]).length).toBe(3)

    const patched = await app.request(`/api/accounts/${accountBody.id}`, {
      method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ enabled: false }),
    })
    expect((await patched.json()).enabled).toBe(false)

    const deleted = await app.request(`/api/accounts/${accountBody.id}`, {
      method: 'DELETE', headers: adminHeaders,
    })
    expect(deleted.status).toBe(200)
  })

  it('import-credential endpoint resets state', async () => {
    const { app } = setup()
    const created = await app.request('/api/accounts', {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ provider: 'mock' }),
    })
    const { id } = await created.json()
    const imported = await app.request(`/api/accounts/${id}/import-credential`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ credential: { token: 'abc' }, expiresAt: 12345 }),
    })
    expect((await imported.json()).tokenExpiryAt).toBe(12345)
  })

  it('jobs and events endpoints', async () => {
    const { app, store } = setup()
    store.createJob({
      id: 'j9', provider: 'mock', accountId: 'mock-a1', jobType: 'token_refresh',
      scheduledAt: 0, startedAt: null, finishedAt: null, status: 'pending',
      error: null, resultJson: null, attempts: 0,
    })
    const jobs = await app.request('/api/jobs?type=token_refresh', { headers: adminHeaders })
    expect(((await jobs.json()).jobs as unknown[]).length).toBe(1)
    const events = await app.request('/api/events?limit=10', { headers: adminHeaders })
    expect(Array.isArray((await events.json()).events)).toBe(true)
  })
})

describe('http — zcode captcha authorize page', () => {
  it('serves the widget page without auth and without embedding secrets', async () => {
    const { app } = setup()
    const res = await app.request('/captcha/zcode')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('initAliyunCaptcha')
    expect(html).toContain('/api/accounts/zcode/captcha')
    // the page must never embed credentials — the operator supplies the token
    expect(html).not.toContain('admin-token-9')
    expect(html).not.toContain('gw-key-123')
  })
})
