/**
 * Phase 3B HTTP surface: provider registration, the interactive login API and
 * the ZCode captcha submission endpoint.
 */
import { describe, expect, it, vi } from 'vitest'
import { CredentialCipher } from '../src/store/crypto.js'
import { MemoryStore } from '../src/store/memory-store.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { loadConfig } from '../src/config/index.js'
import { createGatewayApp } from '../src/http/app.js'
import { registerProviders } from '../src/providers/register.js'
import type { ServiceContext } from '../src/service/context.js'

const ADMIN = 'admin-token-9'

function fetcherFor(routes: Array<{ match: string; status?: number; json?: unknown }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(route.json ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

function setup(fetcher: typeof fetch = fetcherFor([])) {
  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  const { captcha } = registerProviders(registry, { fetcher })
  const ctx: ServiceContext = {
    config: loadConfig({
      GATEWAY_API_KEY: 'gw-key-123',
      GATEWAY_SECRET: '0123456789abcdef',
      GATEWAY_ADMIN_TOKEN: ADMIN,
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
    captcha,
    now: () => Date.now(),
  }
  return { ...createGatewayApp(ctx), store, registry, captcha }
}

function admin(token = ADMIN) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

describe('provider registration', () => {
  it('registers only the remaining built-ins (qoder ×2, zcode) after the buddy-family migration', async () => {
    const { app } = setup()
    const res = await app.request('/api/providers', { headers: admin() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { providers: Array<{ id: string }> }
    const ids = body.providers.map((p) => p.id).sort()
    // The whole buddy family (workbuddy / workbuddy-cn / codebuddy /
    // buddy-intl) is provided by extension deployables via the Extension
    // Manager (extensions/workbuddy, extensions/workbuddycn,
    // src/extensions/codebuddy) — none of them are built-in anymore. Their
    // protocol surfaces are covered by the extension E2E suites.
    expect(ids).toEqual(['qoder', 'qoder-cn', 'zcode'])
  })

  it('login API returns 404/503 for the migrated buddy-family providers (now extension-provided)', async () => {
    const { app } = setup()
    for (const p of ['workbuddy', 'codebuddy', 'buddy-intl']) {
      const res = await app.request(`/api/accounts/${p}/login`, { method: 'POST', headers: admin(), body: '{}' })
      // The in-process adapter is gone; the provider arrives via the Extension
      // Manager (remote registration). Core's login API must NOT fake a flow.
      expect([404, 503]).toContain(res.status)
    }
  })
})

describe('workbuddy providers via extension (post-migration)', () => {
  it('login API returns 404/503 for the migrated workbuddy provider (now extension-provided)', async () => {
    const { app } = setup()
    const res = await app.request('/api/accounts/workbuddy/login', { method: 'POST', headers: admin(), body: '{}' })
    // The in-process adapter is gone; the provider arrives via the Extension
    // Manager (remote registration). Core's login API must NOT fake a flow.
    expect([404, 503]).toContain(res.status)
  })
})
