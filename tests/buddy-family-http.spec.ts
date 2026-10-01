/**
 * End-to-end contract for the new Buddy-family products through the real HTTP
 * layer: registration → /v1/models → /v1/chat/completions (non-stream + stream),
 * with the provider identity reflected back to the client.
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/memory-store.js'
import { CredentialCipher } from '../src/store/crypto.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { loadConfig } from '../src/config/index.js'
import { createGatewayApp } from '../src/http/app.js'
import { createBuddyProvider } from '../src/providers/shared/buddy/provider.js'
import { WORKBUDDY_CN, BUDDY_INTL } from '../src/providers/shared/buddy/product.js'
import { fetcherFor } from './fixtures/buddy-fetcher.js'
import type { Account } from '../src/core/types.js'
import type { ServiceContext } from '../src/service/context.js'

const CATALOG = (provider: string, model: string) => ({
  code: 0,
  data: { data: { models: [{ id: model, name: model, provider }] } },
})

const SSE =
  'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
  'data: [DONE]\n\n'

function setup(product: typeof WORKBUDDY_CN, model: string, provider: string) {
  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  const fetcher = fetcherFor([
    { match: '/v3/config', json: CATALOG(provider, model) },
    { match: '/v2/chat/completions', sse: SSE },
  ])
  registry.register(createBuddyProvider(product, fetcher))
  const acc: Account = {
    id: `${product.id}-a1`, provider: product.id, displayName: product.id, status: 'active',
    enabled: true, authenticated: true, tokenExpiryAt: null, refreshable: true,
    credentialKey: `CRED_${product.id.toUpperCase()}`, failureCount: 0, lastSuccessAt: null,
    lastFailureAt: null, lastError: null, cooldownUntil: null, modelRateLimits: {},
    quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null, quotaManualRequired: false,
    providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
  store.createAccount(acc)
  store.setCredential(acc.credentialKey, cipher.encryptJson({ accessToken: 'tok', domain: product.apiDomain }))
  // models are served from the store; discovery populates it (as bootstrap does)
  store.upsertModels([
    {
      modelId: model,
      provider: product.id,
      upstreamModel: model,
      name: model,
      capabilities: { vision: false, toolCall: false, streaming: true },
      enabled: true,
      priority: 0,
    },
  ])
  const ctx = {
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
  } as unknown as ServiceContext
  return createGatewayApp(ctx)
}

const auth = { Authorization: 'Bearer gw-key-123', 'Content-Type': 'application/json' }

describe.each([
  ['workbuddy-cn', WORKBUDDY_CN, 'glm-5.3'] as const,
  ['buddy-intl', BUDDY_INTL, 'deepseek-v4-flash'] as const,
])('%s end-to-end', (label, product, model) => {
  it('lists its own model with the right owner', async () => {
    const { app } = setup(product, model, label)
    const res = await app.request('/v1/models', { headers: auth })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.some((m: { id: string; owned_by: string }) => m.id === model && m.owned_by === label)).toBe(true)
  })

  it('completes a chat request (non-stream)', async () => {
    const { app } = setup(product, model, label)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message.content).toBe('pong')
  })

  it('streams SSE', async () => {
    const { app } = setup(product, model, label)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'ping' }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('pong')
    expect(text).toContain('[DONE]')
  })
})
