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
  it('registers every Buddy-family product plus zcode', async () => {
    const { app } = setup()
    const res = await app.request('/api/providers', { headers: admin() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { providers: Array<{ id: string }> }
    const ids = body.providers.map((p) => p.id).sort()
    expect(ids).toEqual([
      'buddy-intl', 'codearts', 'codebuddy',
      'qoder', 'qoder-cn', 'workbuddy', 'workbuddy-cn', 'zcode',
    ])
  })
})

describe('POST /api/accounts/:provider/login', () => {
  it('starts a WorkBuddy login and returns the authorization URL', async () => {
    const fetcher = fetcherFor([
      { match: '/v2/plugin/auth/state', json: { code: 0, data: { state: 'st', authUrl: 'https://www.workbuddy.ai/auth?state=st' } } },
    ])
    const { app } = setup(fetcher)
    const res = await app.request('/api/accounts/workbuddy/login', { method: 'POST', headers: admin(), body: '{}' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { login_id: string; status: string; authorization_url: string; poll_interval: number }
    expect(body.status).toBe('pending')
    expect(body.login_id).toMatch(/^workbuddy-/)
    expect(body.authorization_url).toContain('workbuddy.ai/auth')
    expect(body.poll_interval).toBeGreaterThan(0)
  })

  it('completes a WorkBuddy login, persists the credential and syncs models', async () => {
    const fetcher = fetcherFor([
      { match: '/v2/plugin/auth/state', json: { code: 0, data: { state: 'st', authUrl: 'https://a' } } },
      { match: '/v2/plugin/auth/token', json: { code: 0, data: { accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 } } },
      { match: '/v2/plugin/login/account', json: { code: 0, data: { uid: 'u7', type: 'personal' } } },
      { match: '/v3/config', json: { data: { models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] } } },
    ])
    const { app, store } = setup(fetcher)
    const begun = (await (await app.request('/api/accounts/workbuddy/login', { method: 'POST', headers: admin(), body: '{}' })).json()) as { login_id: string }

    const poll = await app.request(`/api/accounts/workbuddy/login/${begun.login_id}`, { headers: admin() })
    const body = (await poll.json()) as { status: string; models_synced: number; account: Record<string, unknown> }
    expect(body.status).toBe('success')
    expect(body.models_synced).toBe(1)

    // the credential is encrypted at rest and reachable via the store
    const stored = store.getAccount(begun.login_id)
    expect(stored?.credential).toBeTruthy()
    const decrypted = new CredentialCipher('0123456789abcdef').decryptJson<{ access_token: string }>(stored!.credential!)
    expect(decrypted.access_token).toBe('at')

    // the poll response must never leak secret material
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('access_token')
    expect(serialized).not.toContain('refresh_token')
    expect(serialized).not.toContain('rt')

    // models become visible
    const models = (await (await app.request('/v1/models', { headers: { Authorization: 'Bearer gw-key-123' } })).json()) as { data: Array<{ id: string }> }
    expect(models.data.map((m) => m.id)).toContain('workbuddy::glm-5.3')
  })

  it('starts a ZCode login (OAuth URL)', async () => {
    const fetcher = fetcherFor([
      { match: '/oauth/cli/init', json: { data: { flow_id: 'f', authorize_url: 'https://zcode.z.ai/authorize' } } },
    ])
    const { app } = setup(fetcher)
    const res = await app.request('/api/accounts/zcode/login', { method: 'POST', headers: admin(), body: '{}' })
    const body = (await res.json()) as { authorization_url: string; login_id: string }
    expect(body.authorization_url).toContain('zcode.z.ai/authorize')
    expect(body.login_id).toMatch(/^zcode-/)
  })

  it('404s for an unknown provider', async () => {
    const { app } = setup()
    const res = await app.request('/api/accounts/nope/login', { method: 'POST', headers: admin(), body: '{}' })
    expect(res.status).toBe(404)
  })

  it('requires the admin token', async () => {
    const { app } = setup()
    const res = await app.request('/api/accounts/workbuddy/login', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/accounts/:provider/captcha', () => {
  it('accepts a ZCode captcha token', async () => {
    const { app, captcha } = setup()
    const res = await app.request('/api/accounts/zcode/captcha', {
      method: 'POST', headers: admin(), body: JSON.stringify({ verify_param: 'verify-abc' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true })
    expect(captcha.peek()).toBe('verify-abc')
  })

  it('rejects an empty token', async () => {
    const { app } = setup()
    const res = await app.request('/api/accounts/zcode/captcha', { method: 'POST', headers: admin(), body: '{}' })
    expect(res.status).toBe(400)
  })

  it('rejects providers that do not use a captcha', async () => {
    const { app } = setup()
    const res = await app.request('/api/accounts/workbuddy/captcha', {
      method: 'POST', headers: admin(), body: JSON.stringify({ verify_param: 'x' }),
    })
    expect(res.status).toBe(400)
  })
})
