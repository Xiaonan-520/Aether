/**
 * Cline end-to-end through the real HTTP layer.
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/memory-store.js'
import { CredentialCipher } from '../src/store/crypto.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { loadConfig } from '../src/config/index.js'
import { createGatewayApp } from '../src/http/app.js'
import { createClineProvider } from '../src/providers/cline/provider.js'
import {
  CLINE_CHAT_PATH,
  CLINE_MODELS_PATH,
  CLINE_RECOMMENDED_MODELS_PATH,
} from '../src/providers/cline/product.js'
import type { Account } from '../src/core/types.js'
import type { ServiceContext } from '../src/service/context.js'

const SSE_BODY =
  'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n'

function fetcher(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes(CLINE_RECOMMENDED_MODELS_PATH)) {
      return new Response(JSON.stringify({ data: { free: [{ id: 'cline-free/x' }] } }), { headers: { 'content-type': 'application/json' } })
    }
    if (url.includes(CLINE_MODELS_PATH)) {
      return new Response(JSON.stringify({ data: [{ id: 'cline-free/x' }, { id: 'anthropic/claude-sonnet-4.5' }] }), { headers: { 'content-type': 'application/json' } })
    }
    if (url.includes(CLINE_CHAT_PATH)) {
      return new Response(SSE_BODY, { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

function setup() {
  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  registry.register(createClineProvider({ fetcher: fetcher() }))
  const acc: Account = {
    id: 'cline-a1', provider: 'cline', displayName: 'cline-a1', status: 'active', enabled: true,
    authenticated: true, tokenExpiryAt: null, refreshable: true, credentialKey: 'CRED_CLINE',
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
  store.createAccount(acc)
  store.setCredential('CRED_CLINE', cipher.encryptJson({ access_token: 'workos:t', refresh_token: 'r', expires_at: String(Date.now() + 3_600_000) }))
  store.upsertModels([
    {
      modelId: 'anthropic/claude-sonnet-4.5', provider: 'cline', upstreamModel: 'anthropic/claude-sonnet-4.5',
      name: 'anthropic/claude-sonnet-4.5', capabilities: { vision: true, toolCall: true, streaming: true },
      enabled: true, priority: 0, metadataJson: null,
    },
  ])
  const ctx = {
    config: loadConfig({
      GATEWAY_API_KEY: 'gw-key-123', GATEWAY_SECRET: '0123456789abcdef', GATEWAY_ADMIN_TOKEN: 'admin-token-9',
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

describe('cline — HTTP end-to-end', () => {
  it('exposes its model via /v1/models', async () => {
    const { app } = setup()
    const res = await app.request('/v1/models', { headers: auth })
    const body = await res.json()
    expect(body.data[0]).toMatchObject({ id: 'anthropic/claude-sonnet-4.5', owned_by: 'cline' })
  })

  it('completes a non-stream chat and an SSE stream', async () => {
    const { app } = setup()
    const nonStream = await app.request('/v1/chat/completions', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-4.5', messages: [{ role: 'user', content: 'ping' }] }),
    })
    expect(nonStream.status).toBe(200)
    expect((await nonStream.json()).choices[0].message.content).toBe('pong')

    const stream = await app.request('/v1/chat/completions', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-4.5', stream: true, messages: [{ role: 'user', content: 'ping' }] }),
    })
    expect(stream.status).toBe(200)
    const text = await stream.text()
    expect(text).toContain('pong')
    expect(text).toContain('[DONE]')
  })
})
