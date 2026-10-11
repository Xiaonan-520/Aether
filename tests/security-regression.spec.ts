/**
 * M0 security regression (docs/EXTENSION_LIFECYCLE.md §8, §10):
 *  - Core HTTP auth matrix: /v1 gateway-key, /api admin token, /healthz open;
 *    no token material ever appears in a response (body or headers);
 *  - extension lifecycle routes: absent without a configured manager, 401
 *    without the admin token (no manager traffic), 503 manager_unavailable,
 *    502 manager_auth_misconfigured on wrong token;
 *  - install-source policy rejects untrusted repos/tags before any manager
 *    call (works even with the manager down);
 *  - Manager API: /healthz open, everything else bearer-gated (deep coverage
 *    lives in tests/manager.spec.ts; asserted here as the security floor).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGatewayApp } from '../src/http/app.js'
import { loadConfig } from '../src/config/index.js'
import { MemoryStore } from '../src/store/memory-store.js'
import { CredentialCipher } from '../src/store/crypto.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { ZCodeCaptchaManager } from '../src/providers/zcode/captcha/index.js'
import { ExtensionManager, LocalProcessRuntime, ManagerStore, startManagerApi } from '../src/manager/index.js'
import { MockProvider, mockModels } from './fixtures/mock-provider.js'
import type { Account, ServiceContextLike } from '../src/core/types.js'
import type { ServiceContext } from '../src/service/context.js'

const ADMIN_TOKEN = 'admin-token-9'
const GATEWAY_KEY = 'gw-key-123'
const MANAGER_TOKEN_RIGHT = 'mgr-token-right'
const MANAGER_TOKEN_WRONG = 'mgr-token-wrong'

function account(provider: string, id: string): Account {
  return {
    id, provider, displayName: id, status: 'active', enabled: true, authenticated: true,
    tokenExpiryAt: null, refreshable: true, credentialKey: `CRED_${id.toUpperCase()}`,
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
}

function baseCtx(overrides: Partial<ServiceContext> = {}): ServiceContext {
  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  const provider = new MockProvider({ id: 'mock', chatScript: [{ type: 'result', result: { content: 'ok', finishReason: 'stop' } }] })
  registry.register(provider)
  for (const acc of [account('mock', 'mock-a1')]) {
    store.createAccount(acc)
    store.setCredential(acc.credentialKey, cipher.encryptJson({ accessToken: 'tok' }))
  }
  store.upsertModels(mockModels('mock'))
  return {
    config: loadConfig({
      GATEWAY_API_KEY: GATEWAY_KEY,
      GATEWAY_SECRET: '0123456789abcdef',
      GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
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
    ...overrides,
  }
}

/** A port that is (very likely) closed — for manager_unavailable paths. */
async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

/** assert no token material leaks anywhere in the response (clone first: body is single-read) */
async function expectNoTokenLeak(res: Response, secrets: string[]): Promise<void> {
  const text = JSON.stringify([...res.headers]) + (await res.clone().text())
  for (const secret of secrets) expect(text).not.toContain(secret)
}

const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` }

// ---------------------------------------------------------------------------

describe('security: core http auth matrix', () => {
  it('keeps /healthz open and gates /v1 on the gateway key', async () => {
    const { app } = { app: createGatewayApp(baseCtx()).app }
    expect((await app.request('/healthz')).status).toBe(200)
    expect((await app.request('/v1/models')).status).toBe(401)
    expect((await app.request('/v1/models', { headers: { Authorization: `Bearer ${GATEWAY_KEY}` } })).status).toBe(200)
  })

  it('rejects /api without a token and never accepts the gateway key as admin', async () => {
    const { app } = { app: createGatewayApp(baseCtx()).app }
    expect((await app.request('/api/accounts')).status).toBe(401)
    expect((await app.request('/api/accounts', { headers: { Authorization: `Bearer ${GATEWAY_KEY}` } })).status).toBe(401)
    expect((await app.request('/api/accounts', { headers: admin })).status).toBe(200)
  })

  it('leaks no token material on auth failures (body + headers)', async () => {
    const { app } = { app: createGatewayApp(baseCtx()).app }
    for (const res of [
      await app.request('/v1/models', { headers: { Authorization: 'Bearer wrong' } }),
      await app.request('/api/accounts'),
      await app.request('/api/console/overview', { headers: { Authorization: 'Bearer wrong' } }),
    ]) {
      expect(res.status).toBe(401)
      await expectNoTokenLeak(res, [GATEWAY_KEY, ADMIN_TOKEN])
    }
  })

  it('serves no extension routes when no manager is configured', async () => {
    const { app } = { app: createGatewayApp(baseCtx()).app }
    const res = await app.request('/api/console/extensions', { headers: admin })
    expect(res.status).toBe(404)
    await expectNoTokenLeak(res, [ADMIN_TOKEN])
  })
})

describe('security: extension lifecycle surface', () => {
  let managerServer: Server
  let managerUrl: string
  let store: ManagerStore

  beforeEach(async () => {
    store = new ManagerStore(join(mkdtempSync(join(tmpdir(), 'gw-sec-')), 'manager.db'))
    const manager = new ExtensionManager({ store, runtime: new LocalProcessRuntime() })
    managerServer = await startManagerApi({ manager, token: MANAGER_TOKEN_RIGHT })
    const addr = managerServer.address() as { port: number }
    managerUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    managerServer.close()
    store.close()
  })

  it('requires the admin token before any manager traffic; browser never sees the manager token', async () => {
    const { app } = createGatewayApp(baseCtx({ extensionManager: { managerUrl, managerToken: MANAGER_TOKEN_RIGHT } }))
    const res = await app.request('/api/console/extensions')
    expect(res.status).toBe(401)
    await expectNoTokenLeak(res, [ADMIN_TOKEN, MANAGER_TOKEN_RIGHT])

    const ok = await app.request('/api/console/extensions', { headers: admin })
    expect(ok.status).toBe(200)
    await expectNoTokenLeak(ok, [MANAGER_TOKEN_RIGHT])
    expect(await ok.json()).toEqual({ extensions: [] })
  })

  it('maps a dead manager to 503 manager_unavailable', async () => {
    const dead = `http://127.0.0.1:${await closedPort()}`
    const { app } = createGatewayApp(baseCtx({ extensionManager: { managerUrl: dead, managerToken: MANAGER_TOKEN_RIGHT } }))
    const res = await app.request('/api/console/extensions', { headers: admin })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: 'manager_unavailable' } })
  })

  it('maps a misconfigured manager token to 502 manager_auth_misconfigured', async () => {
    const { app } = createGatewayApp(baseCtx({ extensionManager: { managerUrl, managerToken: MANAGER_TOKEN_WRONG } }))
    const res = await app.request('/api/console/extensions', { headers: admin })
    expect(res.status).toBe(502)
    await expectNoTokenLeak(res, [MANAGER_TOKEN_RIGHT, MANAGER_TOKEN_WRONG])
    expect(await res.json()).toMatchObject({ error: { code: 'manager_auth_misconfigured' } })
  })

  it('rejects untrusted image sources before contacting the manager (works with the manager down)', async () => {
    const dead = `http://127.0.0.1:${await closedPort()}`
    const { app } = createGatewayApp(baseCtx({ extensionManager: { managerUrl: dead, managerToken: MANAGER_TOKEN_RIGHT } }))
    const manifest = { protocol: 'v1', extension: { id: 'fake', name: 'F', version: '1.0.0' } }

    const evilRepo = await app.request('/api/console/extensions/install', {
      method: 'POST', headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest, image: { repo: 'docker.io/evil/fake', tag: '1.0.0' } }),
    })
    expect(evilRepo.status).toBe(400)
    expect(await evilRepo.json()).toMatchObject({ error: { code: 'forbidden_image_source' } })

    const evilTag = await app.request('/api/console/extensions/install', {
      method: 'POST', headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest, image: { repo: 'local/gateway-extension-fake', tag: '9.9.9' } }),
    })
    expect(evilTag.status).toBe(400)
    expect((await evilTag.json() as { error: { code: string } }).error.code).toBe('forbidden_image_source')

    // policy-clean request proceeds to the manager → unavailable, not forbidden
    const clean = await app.request('/api/console/extensions/install', {
      method: 'POST', headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
    })
    expect(clean.status).toBe(503)
  })

  it('manager api floor: /healthz open, api bearer-gated, no docker passthrough', async () => {
    expect((await fetch(`${managerUrl}/healthz`)).status).toBe(200)
    expect((await fetch(`${managerUrl}/api/extensions`)).status).toBe(401)
    expect((await fetch(`${managerUrl}/api/extensions`, { headers: { authorization: `Bearer ${MANAGER_TOKEN_RIGHT}` } })).status).toBe(200)
    const docker = await fetch(`${managerUrl}/containers/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${MANAGER_TOKEN_RIGHT}`, 'content-type': 'application/json' },
      body: JSON.stringify({ HostConfig: { Privileged: true } }),
    })
    expect(docker.status).toBe(404)
  })
})
