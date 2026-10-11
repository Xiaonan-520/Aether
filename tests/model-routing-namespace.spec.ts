/**
 * Model namespace & routing regression tests (Phase 3 task A).
 *
 * Pins the `provider::model` namespace contract end to end:
 * - explicit prefix → exact provider;
 * - bare model id → compatible route on a single provider, explicit 400 on
 *   ambiguity across providers (never a silent priority pick);
 * - upstream always receives the bare `upstreamModel`, never the prefix;
 * - sync via the provider adapters never re-introduces bare model ids.
 */
import { describe, expect, it } from 'vitest'
import { CredentialCipher } from '../src/store/crypto.js'
import { MemoryStore } from '../src/store/memory-store.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { loadConfig } from '../src/config/index.js'
import { createGatewayApp } from '../src/http/app.js'
import { ModelService } from '../src/service/model-service.js'
import { ChatService } from '../src/service/chat-service.js'
import { LoginService } from '../src/service/login-service.js'
import { MockProvider } from './fixtures/mock-provider.js'
import { createZCodeProvider } from '../src/providers/zcode/provider.js'
import { createBuddyProvider } from '../src/providers/shared/buddy/provider.js'
import { WORKBUDDY_CN } from '../src/providers/shared/buddy/product.js'
import { createLobsteraiProvider } from '../src/providers/lobsterai/provider.js'
import { createClineProvider } from '../src/providers/cline/provider.js'
import { createCodeArtsProvider } from '../src/providers/codearts/provider.js'
import { createLoomyProvider } from '../src/providers/loomy/provider.js'
import { createQoderProvider } from '../src/providers/qoder/provider.js'
import { QODER, QODER_CN } from '../src/providers/qoder/product.js'
import { createRaccoonProvider } from '../src/providers/raccoon/provider.js'
import { createTraeProvider } from '../src/providers/trae/provider.js'
import { TRAE, TRAE_INTL } from '../src/providers/trae/product.js'
import type { Provider } from '../src/core/registry/provider.js'
import { fetcherFor } from './fixtures/buddy-fetcher.js'
import type { Account, ChatRequest, ModelEntry } from '../src/core/types.js'
import type { ServiceContext } from '../src/service/context.js'

const CHAT_REQ: ChatRequest = {
  model: 'unused',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
}

function account(provider: string, id: string): Account {
  return {
    id, provider, displayName: id, status: 'active', enabled: true, authenticated: true,
    tokenExpiryAt: null, refreshable: true, credentialKey: `CRED_${id.toUpperCase()}`,
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
}

function entry(modelId: string, provider: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    modelId, provider, upstreamModel: modelId,
    name: modelId, capabilities: { vision: false, toolCall: false, streaming: true },
    enabled: true, priority: 10, metadataJson: null,
    ...overrides,
  }
}

interface Harness {
  app: ReturnType<typeof createGatewayApp>['app']
  store: MemoryStore
  chat: ChatService
  models: ModelService
  logins: LoginService
  providers: MockProvider[]
}

function setup(opts: {
  providers?: Array<{ id: string; models: ModelEntry[]; accounts?: string[] }>
  accounts?: Account[]
} = {}): Harness {
  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  const providers: MockProvider[] = []

  const specs = opts.providers ?? [
    { id: 'mock', models: [entry('mock-model', 'mock')], accounts: ['mock-a1'] },
  ]
  for (const spec of specs) {
    const provider = new MockProvider({ id: spec.id, models: spec.models })
    registry.register(provider)
    providers.push(provider)
    for (const id of spec.accounts ?? [`${spec.id}-a1`]) {
      store.createAccount(account(spec.id, id))
      store.setCredential(`CRED_${id.toUpperCase()}`, cipher.encryptJson({ accessToken: 'tok' }))
    }
    store.upsertModels(spec.models)
  }

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
    captcha: undefined as never,
  }
  return {
    app: createGatewayApp(ctx).app,
    store, providers,
    chat: new ChatService(ctx),
    models: new ModelService(ctx),
    logins: new LoginService(ctx),
  }
}

describe('model routing — namespaced ids', () => {
  it('routes provider::model to exactly that provider even when others share the upstream', async () => {
    const h = setup({
      providers: [
        { id: 'alpha', models: [entry('alpha::shared', 'alpha', { upstreamModel: 'shared' })] },
        { id: 'beta', models: [entry('beta::shared', 'beta', { upstreamModel: 'shared' })] },
      ],
    })
    const outcome = await h.chat.handle({ ...CHAT_REQ, model: 'beta::shared' })
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.provider).toBe('beta')
  })

  it('sends the bare upstreamModel upstream (never the namespace prefix)', async () => {
    const h = setup({
      providers: [
        { id: 'alpha', models: [entry('alpha::pfx-model', 'alpha', { upstreamModel: 'pfx-model' })] },
      ],
    })
    const outcome = await h.chat.handle({ ...CHAT_REQ, model: 'alpha::pfx-model' })
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.upstreamModel).toBe('pfx-model')
    expect(h.providers[0]!.chatCalls[0]!.req.model).toBe('pfx-model')
    expect(h.providers[0]!.chatCalls[0]!.req.model).not.toContain('::')
  })

  it('unknown provider prefix and unknown model resolve to nothing (404)', async () => {
    const h = setup()
    await expect(h.chat.handle({ ...CHAT_REQ, model: 'nosuch::mock-model' })).rejects.toMatchObject({
      status: 404,
      type: 'invalid_request_error',
    })
    await expect(h.chat.handle({ ...CHAT_REQ, model: 'nosuch-model' })).rejects.toMatchObject({
      status: 404,
    })
  })

  it('treats a disabled model row as absent (404), even with the right prefix', async () => {
    const h = setup({
      providers: [{ id: 'alpha', models: [entry('alpha::m', 'alpha')] }],
    })
    h.store.upsertModels([entry('alpha::m', 'alpha', { enabled: false })])
    await expect(h.chat.handle({ ...CHAT_REQ, model: 'alpha::m' })).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe('model routing — bare ids and ambiguity', () => {
  it('keeps bare-id compatibility when exactly one provider exposes the model', async () => {
    const h = setup({
      providers: [{ id: 'alpha', models: [entry('alpha::solo', 'alpha', { upstreamModel: 'solo' })] }],
    })
    const outcome = await h.chat.handle({ ...CHAT_REQ, model: 'solo' })
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.provider).toBe('alpha')
  })

  it('rejects a bare id exposed by multiple enabled providers instead of silently picking one', async () => {
    const h = setup({
      providers: [
        { id: 'alpha', models: [entry('alpha::dup', 'alpha', { upstreamModel: 'dup' })] },
        { id: 'beta', models: [entry('beta::dup', 'beta', { upstreamModel: 'dup' })] },
      ],
    })
    await expect(h.chat.handle({ ...CHAT_REQ, model: 'dup' })).rejects.toMatchObject({
      name: 'AmbiguousModelError',
      candidates: ['alpha::dup', 'beta::dup'],
    })
    // the diagnostic message names the candidates and carries no secrets
    try {
      await h.chat.handle({ ...CHAT_REQ, model: 'dup' })
      expect.unreachable('ambiguous bare id must not route')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('alpha')
      expect(message).toContain('beta')
      expect(message).toContain('beta::dup')
      expect(message.toLowerCase()).not.toContain('token')
      expect(message.toLowerCase()).not.toContain('cookie')
      expect(message).not.toContain('accessToken')
    }
  })

  it('does not invent ambiguity when the same provider has duplicate rows', async () => {
    const h = setup({
      providers: [{ id: 'alpha', models: [entry('alpha::dup2', 'alpha', { upstreamModel: 'dup2' })] }],
    })
    h.store.upsertModels([entry('dup2', 'alpha', { upstreamModel: 'dup2', priority: 5 })])
    const outcome = await h.chat.handle({ ...CHAT_REQ, model: 'dup2' })
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.provider).toBe('alpha')
  })

  it('does not count a disabled provider toward the ambiguity set', async () => {
    const h = setup({
      providers: [
        { id: 'alpha', models: [entry('alpha::solo2', 'alpha', { upstreamModel: 'solo2' })] },
        { id: 'beta', models: [entry('beta::solo2', 'beta', { upstreamModel: 'solo2' })] },
      ],
    })
    for (const s of h.store.listAccounts('beta')) h.store.patchAccount(s.account.id, { enabled: false })
    const outcome = await h.chat.handle({ ...CHAT_REQ, model: 'solo2' })
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.provider).toBe('alpha')
  })

  it('routes a bare id when only one of the matching providers has a usable account', async () => {
    const h = setup({
      providers: [
        { id: 'alpha', models: [entry('alpha::amb', 'alpha', { upstreamModel: 'amb' })] },
        // beta exposes the model but has no accounts → not a usable candidate
        { id: 'beta', models: [entry('beta::amb', 'beta', { upstreamModel: 'amb' })], accounts: [] },
      ],
    })
    const outcome = await h.chat.handle({ ...CHAT_REQ, model: 'amb' })
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.provider).toBe('alpha')
  })

  it('serves the ambiguous model over HTTP as 400 with a namespaced hint', async () => {
    const h = setup({
      providers: [
        { id: 'alpha', models: [entry('alpha::dup-http', 'alpha', { upstreamModel: 'dup-http' })] },
        { id: 'beta', models: [entry('beta::dup-http', 'beta', { upstreamModel: 'dup-http' })] },
      ],
    })
    const res = await h.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer gw-key-123', 'content-type': 'application/json' },
      body: JSON.stringify({ ...CHAT_REQ, model: 'dup-http' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.message).toContain('alpha::dup-http')
    expect(body.error.message).toContain('beta::dup-http')
  })
})

describe('/v1/models — namespace listing contract', () => {
  it('hides bare duplicates once a canonical namespaced row exists', () => {
    const h = setup({
      providers: [{ id: 'alpha', models: [entry('alpha::m', 'alpha', { upstreamModel: 'm' })] }],
    })
    h.store.upsertModels([entry('m', 'alpha', { upstreamModel: 'm', priority: 5 })])
    const ids = h.models.list().map((m) => m.id)
    expect(ids).toContain('alpha::m')
    expect(ids).not.toContain('m')
  })

  it('keeps a bare id visible when it is the only form (single provider)', () => {
    const h = setup({
      providers: [{ id: 'alpha', models: [entry('solo-bare', 'alpha')] }],
    })
    expect(h.models.list().map((m) => m.id)).toContain('solo-bare')
  })

  it('the same public id on two providers stays distinct and prefixed rows win listing', () => {
    const h = setup({
      providers: [
        { id: 'alpha', models: [entry('alpha::pub', 'alpha', { upstreamModel: 'pub' })] },
        { id: 'beta', models: [entry('beta::pub', 'beta', { upstreamModel: 'pub' })] },
      ],
    })
    const ids = h.models.list().map((m) => m.id).sort()
    expect(ids).toEqual(['alpha::pub', 'beta::pub'])
  })
})

describe('built-in provider sync — namespace normalization', () => {
  it('zcode listModels emits provider::model ids with bare upstreamModel', async () => {
    const provider = createZCodeProvider()
    const models = await provider.chat.listModels(
      { provider: 'zcode', resolveCredential: async () => undefined },
      account('zcode', 'z-a'),
    )
    expect(models.length).toBeGreaterThan(0)
    for (const m of models) {
      expect(m.modelId).toMatch(/^zcode::/)
      expect(m.modelId).not.toBe(m.upstreamModel)
      expect(m.modelId).toBe(`zcode::${m.upstreamModel}`)
    }
  })

  it('buddy listModels emits provider::model ids from the remote catalog', async () => {
    const fetcher = fetcherFor([
      { match: '/v3/config', json: { data: { models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] } } },
    ])
    const provider = createBuddyProvider(WORKBUDDY_CN, fetcher)
    const ctx = {
      provider: WORKBUDDY_CN.id,
      resolveCredential: async () => ({
        ref: 'CRED', expiresAt: null, refreshable: true,
        credential: {
          access_token: 'at', refresh_token: 'rt', expires_at: 9, refresh_expires_at: 9,
          token_type: 'Bearer', scope: 's', domain: WORKBUDDY_CN.apiDomain, user_id: 'u1',
        },
      }),
    }
    const models = await provider.chat.listModels(ctx, account(WORKBUDDY_CN.id, 'w-a'))
    expect(models).toHaveLength(1)
    expect(models[0]!.modelId).toBe(`${WORKBUDDY_CN.id}::glm-5.3`)
    expect(models[0]!.upstreamModel).toBe('glm-5.3')
  })

  it('lobsterai listModels normalizes both remote and fallback catalogs', async () => {
    const provider = createLobsteraiProvider({ fetcher: fetcherFor([]) })
    const ctx = { provider: 'lobsterai', resolveCredential: async () => undefined }
    const models = await provider.chat.listModels(ctx, account('lobsterai', 'l-a'))
    expect(models.length).toBeGreaterThan(0)
    for (const m of models) {
      expect(m.modelId).toMatch(/^lobsterai::/)
      expect(m.modelId).toBe(`lobsterai::${m.upstreamModel}`)
    }
  })

  it('every built-in adapter emits provider-prefixed ids keyed by its real product id', async () => {
    // multi-product adapters (trae, qoder) must namespace by the actual
    // product instance, never a single hard-coded literal
    for (const [factory, productId] of [
      [() => createClineProvider(), 'cline'],
      [() => createCodeArtsProvider(), 'codearts'],
      [() => createLoomyProvider(), 'loomy'],
      [() => createQoderProvider({ product: QODER }), 'qoder'],
      [() => createQoderProvider({ product: QODER_CN }), 'qoder-cn'],
      [() => createRaccoonProvider(), 'raccoon'],
      [() => createTraeProvider({ product: TRAE }), 'trae'],
      [() => createTraeProvider({ product: TRAE_INTL }), 'trae-intl'],
    ] as const) {
      const provider = (factory as () => Provider)()
      expect(provider.id).toBe(productId)
      const models = await provider.chat.listModels(
        { provider: productId, resolveCredential: async () => undefined },
        account(productId, `${productId}-a`),
      )
      expect(models.length, productId).toBeGreaterThan(0)
      for (const m of models) {
        expect(m.modelId, productId).toBe(`${productId}::${m.upstreamModel}`)
        expect(m.modelId.startsWith(`${productId}::`), productId).toBe(true)
      }
    }
  })

  it('syncModels persists the namespaced ids and never re-writes bare rows', async () => {
    const h = setup({
      providers: [{ id: 'alpha', models: [entry('alpha::from-sync', 'alpha', { upstreamModel: 'from-sync' })] }],
    })
    const synced = await h.logins.syncModels('alpha', h.store.listAccounts('alpha')[0]!.account)
    expect(synced).toBe(1)
    const rows = h.store.listModels().filter((m) => m.provider === 'alpha')
    expect(rows.map((m) => m.modelId)).toEqual(['alpha::from-sync'])
    expect(rows.some((m) => !m.modelId.includes('::'))).toBe(false)
  })

  it('re-syncing an already-namespaced catalog never double-prefixes model ids', async () => {
    const provider = createZCodeProvider()
    const models = await provider.chat.listModels(
      { provider: 'zcode', resolveCredential: async () => undefined },
      account('zcode', 'z-a'),
    )
    // a second sync over the first output must be idempotent: the ids the
    // adapter emits are built from the bare upstream id, never from a previous
    // (already prefixed) modelId
    const resynced = models.map((m) => ({ ...m, modelId: `${m.provider}::${m.upstreamModel}` }))
    expect(resynced.map((m) => m.modelId)).toEqual(models.map((m) => m.modelId))
    expect(resynced.every((m) => m.modelId.split('::').length === 2)).toBe(true)
  })
})
