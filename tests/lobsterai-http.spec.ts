/**
 * LobsterAI end-to-end through the real HTTP layer: /v1/models and
 * /v1/chat/completions (non-stream + stream), confirming the adapter is wired
 * like any other provider and needs no client-specific handling.
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/memory-store.js'
import { CredentialCipher } from '../src/store/crypto.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { loadConfig } from '../src/config/index.js'
import { createGatewayApp } from '../src/http/app.js'
import { createLobsteraiProvider } from '../src/providers/lobsterai/provider.js'
import type { Account } from '../src/core/types.js'
import type { ServiceContext } from '../src/service/context.js'

const SSE_BODY =
  'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
  'data: [DONE]\n\n'

function fetcher(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('api-overmind.youdao.com')) {
      return new Response(JSON.stringify({ data: { value: { version: '2026.9.4' } } }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/api/models/available')) {
      return new Response(
        JSON.stringify({ code: 0, data: { models: [{ id: 'kimi-k3', name: 'Kimi K3' }] } }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/api/proxy/v1/chat/completions')) {
      return new Response(SSE_BODY, { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

function setup() {
  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  registry.register(createLobsteraiProvider({ fetcher: fetcher() }))
  const acc: Account = {
    id: 'lobsterai-a1', provider: 'lobsterai', displayName: 'lobsterai-a1', status: 'active',
    enabled: true, authenticated: true, tokenExpiryAt: null, refreshable: true,
    credentialKey: 'CRED_LOBSTERAI', failureCount: 0, lastSuccessAt: null, lastFailureAt: null,
    lastError: null, cooldownUntil: null, modelRateLimits: {}, quotaJson: null, lastQuotaAt: null,
    lastCreditClaimAt: null, quotaManualRequired: false, providerMetadataJson: null,
    createdAt: 0, updatedAt: 0,
  }
  store.createAccount(acc)
  store.setCredential(
    'CRED_LOBSTERAI',
    cipher.encryptJson({ access_token: 'tok', refresh_token: 'ref', expires_at: String(Date.now() + 3_600_000) }),
  )
  store.upsertModels([
    {
      modelId: 'kimi-k3', provider: 'lobsterai', upstreamModel: 'kimi-k3', name: 'Kimi K3',
      capabilities: { vision: true, toolCall: true, streaming: true }, enabled: true, priority: 0,
      metadataJson: null,
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

describe('lobsterai — HTTP end-to-end', () => {
  it('exposes its model via /v1/models', async () => {
    const { app } = setup()
    const res = await app.request('/v1/models', { headers: auth })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data[0]).toMatchObject({ id: 'kimi-k3', owned_by: 'lobsterai' })
  })

  it('completes a non-stream chat (aggregated from the SSE-only upstream)', async () => {
    const { app } = setup()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'ping' }] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message.content).toBe('pong')
  })

  it('streams SSE with a content-parts request', async () => {
    const { app } = setup()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'kimi-k3',
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('pong')
    expect(text).toContain('[DONE]')
  })
})
