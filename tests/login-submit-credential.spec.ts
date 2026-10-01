/**
 * Regression: providers whose login cannot complete by polling alone
 * (lobsterai / trae / codearts) must be able to finish via credential
 * submission — the adapter performs the exchange and the service persists the
 * credential it returns.
 *
 * Before this route existed, `pollLogin` for those providers never returned
 * success and `auth.importCredential` was unreachable, so the providers could
 * never be logged in.
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
import { LOBSTERAI_EXCHANGE_PATH } from '../src/providers/lobsterai/protocol.js'
import type { Provider } from '../src/core/registry/provider.js'
import type { ServiceContext } from '../src/service/context.js'

function setup(provider: Provider) {
  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  registry.register(provider)
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
  return { ...createGatewayApp(ctx), store }
}

const admin = { Authorization: 'Bearer admin-token-9', 'Content-Type': 'application/json' }

interface Route { match: string; json?: unknown; status?: number }
function makeFetcher(routes: Route[]) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const r of routes) {
      if (!url.includes(r.match)) continue
      return new Response(JSON.stringify(r.json ?? {}), {
        status: r.status ?? 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

describe('POST /api/accounts/:provider/login/:id/credential', () => {
  it('completes a LobsterAI login from an auth code and persists the credential', async () => {
    const provider = createLobsteraiProvider({
      fetcher: makeFetcher([
        { match: '/openapi/get/luna/hardware/lobsterai', json: { data: { value: { version: '2026.9.4' } } } },
        {
          match: LOBSTERAI_EXCHANGE_PATH,
          json: {
            code: 0,
            data: { accessToken: 'acc-x', refreshToken: 'ref-x', expiresIn: 3600, user: { id: 'u1', nickname: 'Nina' } },
          },
        },
        { match: '/api/models/available', json: { code: 0, data: { models: [{ id: 'kimi-k3', name: 'Kimi K3' }] } } },
      ]),
    })
    const { app, store } = setup(provider)

    const started = await (await app.request('/api/accounts/lobsterai/login', { method: 'POST', body: '{}', headers: admin })).json()
    const loginId = started.login_id as string

    // poll alone can never finish for this provider
    const polled = await (await app.request(`/api/accounts/lobsterai/login/${loginId}`, { headers: admin })).json()
    expect(polled.status).toBe('pending')

    const res = await app.request(`/api/accounts/lobsterai/login/${loginId}/credential`, {
      method: 'POST', headers: admin, body: JSON.stringify({ code: 'one-time-code' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('success')
    expect(body.account.authenticated).toBe(true)
    expect(body.account.status).toBe('active')

    // the credential the adapter exchanged was persisted (encrypted at rest)
    const stored = store.getAccount(loginId)
    expect(stored?.credential).toBeTruthy()
    expect(JSON.stringify(stored?.credential)).not.toContain('acc-x')
    expect(JSON.stringify(stored?.credential)).not.toContain('one-time-code')
  })

  it('accepts the payload nested under "credential" too', async () => {
    const provider = createLobsteraiProvider({
      fetcher: makeFetcher([
        { match: '/openapi/get/luna/hardware/lobsterai', json: { data: { value: { version: '2026.9.4' } } } },
        { match: LOBSTERAI_EXCHANGE_PATH, json: { code: 0, data: { accessToken: 'a', refreshToken: 'r', expiresIn: 60 } } },
      ]),
    })
    const { app } = setup(provider)
    const started = await (await app.request('/api/accounts/lobsterai/login', { method: 'POST', body: '{}', headers: admin })).json()
    const res = await app.request(`/api/accounts/lobsterai/login/${started.login_id}/credential`, {
      method: 'POST', headers: admin, body: JSON.stringify({ credential: { code: 'c' } }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('success')
  })

  it('returns a structured 400 (not 500) when the exchange is rejected', async () => {
    const provider = createLobsteraiProvider({
      fetcher: makeFetcher([
        { match: '/openapi/get/luna/hardware/lobsterai', json: { data: { value: { version: '2026.9.4' } } } },
        { match: LOBSTERAI_EXCHANGE_PATH, json: { code: 40102, message: 'invalid or expired code' } },
      ]),
    })
    const { app } = setup(provider)
    const started = await (await app.request('/api/accounts/lobsterai/login', { method: 'POST', body: '{}', headers: admin })).json()
    const res = await app.request(`/api/accounts/lobsterai/login/${started.login_id}/credential`, {
      method: 'POST', headers: admin, body: JSON.stringify({ code: 'bad' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('rejects a missing payload with 400', async () => {
    const provider = createLobsteraiProvider({ fetcher: makeFetcher([]) })
    const { app } = setup(provider)
    const started = await (await app.request('/api/accounts/lobsterai/login', { method: 'POST', body: '{}', headers: admin })).json()
    const res = await app.request(`/api/accounts/lobsterai/login/${started.login_id}/credential`, {
      method: 'POST', headers: admin, body: JSON.stringify({}),
    })
    // an empty body falls back to `{}` which has no code/access_token
    expect(res.status).toBe(400)
  })

  it('is unknown for a provider id that does not exist', async () => {
    const provider = createLobsteraiProvider({ fetcher: makeFetcher([]) })
    const { app } = setup(provider)
    const res = await app.request('/api/accounts/nope/login/x/credential', {
      method: 'POST', headers: admin, body: JSON.stringify({ code: 'c' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/accounts/:id/import-credential — validation (regression)', () => {
  it('returns 400 rather than 500 when credential is missing', async () => {
    const provider = createLobsteraiProvider({ fetcher: makeFetcher([]) })
    const { app } = setup(provider)
    const started = await (await app.request('/api/accounts/lobsterai/login', { method: 'POST', body: '{}', headers: admin })).json()
    const res = await app.request(`/api/accounts/${started.login_id}/import-credential`, {
      method: 'POST', headers: admin, body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.type).toBe('invalid_request_error')
  })
})
