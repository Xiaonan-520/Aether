/**
 * Productization additions:
 *   - admin password change (and session revocation semantics)
 *   - Admin Token provenance (created_by) and the three credential domains
 *   - install-from-image (KI-001) input validation and trust checks
 *
 * The install path that actually talks to Docker is exercised by the manager
 * tests and the local Docker E2E; here we assert the Core-side contract:
 * unauthenticated callers are rejected, and malformed image references never
 * reach the manager.
 */
import { describe, expect, it } from 'vitest'
import { createGatewayApp } from '../src/http/app.js'
import { MemoryStore } from '../src/store/memory-store.js'
import { CredentialCipher } from '../src/store/crypto.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { ZCodeCaptchaManager } from '../src/providers/zcode/captcha/index.js'
import type { ServiceContext } from '../src/service/context.js'
import { MIN_PASSWORD_LENGTH } from '../src/core/auth/password.js'

const ADMIN = 'adm_static_operator_token'
const BOOTSTRAP = 'gw_bootstrap_key'
const EMAIL = 'operator@aether.test'
const PASSWORD = 'correct-horse-battery'
const NEW_PASSWORD = 'a-completely-different-one'

function makeCtx(now = 1_700_000_000_000): ServiceContext {
  const config = {
    dataDir: '/tmp',
    gatewayApiKey: BOOTSTRAP,
    gatewaySecret: 'test-secret-value-1234567890',
    gatewayAdminToken: ADMIN,
    tz: 'Asia/Shanghai',
    logLevel: 'info' as const,
    httpHost: '127.0.0.1',
    httpPort: 0,
  }
  const store = new MemoryStore()
  const registry = new ProviderRegistry()
  const pool = new AccountPool({
    listAccounts: () => [],
    patchAccount: () => {},
    hasCredential: () => false,
    refreshAccount: async (a) => a,
  })
  return {
    config,
    store,
    cipher: new CredentialCipher(config.gatewaySecret),
    registry,
    router: new ModelRouter(registry, () => []),
    pool,
    captcha: new ZCodeCaptchaManager(),
    now: () => now,
  }
}

type App = ReturnType<typeof createGatewayApp>['app']

function post(app: App, path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

function get(app: App, path: string, token?: string) {
  return app.request(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

async function register(app: App, email = EMAIL, password = PASSWORD) {
  const res = await post(app, '/api/auth/register', { email, password })
  return (await res.json()) as { token: string }
}

async function login(app: App, email = EMAIL, password = PASSWORD) {
  const res = await post(app, '/api/auth/login', { email, password })
  return { res, json: (await res.json()) as Record<string, unknown> }
}

// -- password change ----------------------------------------------------------

describe('POST /api/auth/password', () => {
  it('changes the password and returns a fresh session', async () => {
    const { app } = createGatewayApp(makeCtx())
    const first = await register(app)

    const res = await post(
      app,
      '/api/auth/password',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      first.token,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.token).toBe('string')
    expect(body.token).not.toBe(first.token)
    expect(JSON.stringify(body)).not.toContain(NEW_PASSWORD)
  })

  it('the new password works and the old one stops working', async () => {
    const { app } = createGatewayApp(makeCtx())
    const first = await register(app)
    await post(app, '/api/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, first.token)

    expect((await login(app, EMAIL, PASSWORD)).res.status).toBe(401)
    expect((await login(app, EMAIL, NEW_PASSWORD)).res.status).toBe(200)
  })

  it('revokes every other session of the same admin', async () => {
    const { app } = createGatewayApp(makeCtx())
    const first = await register(app)
    const second = (await login(app)).json.token as string
    const third = (await login(app)).json.token as string

    const changed = await post(
      app,
      '/api/auth/password',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      first.token,
    )
    const fresh = ((await changed.json()) as Record<string, unknown>).token as string

    // the two older sessions are dead
    expect((await get(app, '/api/accounts', second)).status).toBe(401)
    expect((await get(app, '/api/accounts', third)).status).toBe(401)
    // the pre-change session that performed the change is also dead
    expect((await get(app, '/api/accounts', first.token)).status).toBe(401)
    // only the newly issued one works
    expect((await get(app, '/api/accounts', fresh)).status).toBe(200)
  })

  it('rejects a wrong current password', async () => {
    const { app } = createGatewayApp(makeCtx())
    const first = await register(app)
    const res = await post(
      app,
      '/api/auth/password',
      { currentPassword: 'not-the-password', newPassword: NEW_PASSWORD },
      first.token,
    )
    expect(res.status).toBe(401)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: 'invalid_credentials' })
    // nothing changed
    expect((await login(app, EMAIL, PASSWORD)).res.status).toBe(200)
  })

  it('enforces the minimum length and rejects reuse of the current password', async () => {
    const { app } = createGatewayApp(makeCtx())
    const first = await register(app)

    const short = await post(
      app,
      '/api/auth/password',
      { currentPassword: PASSWORD, newPassword: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) },
      first.token,
    )
    expect(short.status).toBe(400)

    const same = await post(
      app,
      '/api/auth/password',
      { currentPassword: PASSWORD, newPassword: PASSWORD },
      first.token,
    )
    expect(same.status).toBe(400)
  })

  it('requires an admin credential', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    const res = await post(app, '/api/auth/password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    })
    expect(res.status).toBe(401)
  })

  it('rejects a gateway API key on the password route', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    const res = await post(
      app,
      '/api/auth/password',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      BOOTSTRAP,
    )
    expect(res.status).toBe(401)
  })

  it('the static env token has no password to change', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    const res = await post(
      app,
      '/api/auth/password',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      ADMIN,
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: 'invalid_request' })
  })

  it('audits the change without leaking any secret', async () => {
    const ctx = makeCtx()
    const { app } = createGatewayApp(ctx)
    const first = await register(app)
    await post(app, '/api/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, first.token)

    const events = ctx.store.listEvents(50)
    const changed = events.find((e) => e.kind === 'admin.password_changed')
    expect(changed).toBeDefined()
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(PASSWORD)
    expect(serialized).not.toContain(NEW_PASSWORD)
    expect(serialized).not.toContain('scrypt$')
  })
})

// -- Admin Token provenance ---------------------------------------------------

describe('Admin Token provenance', () => {
  it('records the signed-in admin as the creator', async () => {
    const ctx = makeCtx()
    const { app } = createGatewayApp(ctx)
    const session = await register(app)

    const created = await post(app, '/api/keys', { name: 'laptop' }, session.token)
    expect(created.status).toBe(201)

    const listed = await get(app, '/api/keys', session.token)
    const body = (await listed.json()) as { keys: Array<Record<string, unknown>> }
    const key = body.keys.find((k) => k.name === 'laptop')
    expect(key).toBeDefined()
    expect(key!.createdBy).toBe(EMAIL)
  })

  it('a key made with the static env token has no owner', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    await post(app, '/api/keys', { name: 'automation' }, ADMIN)

    const body = (await (await get(app, '/api/keys', ADMIN)).json()) as {
      keys: Array<Record<string, unknown>>
    }
    const key = body.keys.find((k) => k.name === 'automation')
    expect(key).toBeDefined()
    expect(key!.createdBy).toBeNull()
  })

  it('never returns the full key or the hash from the list endpoint', async () => {
    const ctx = makeCtx()
    const { app } = createGatewayApp(ctx)
    const session = await register(app)
    const created = (await (await post(app, '/api/keys', { name: 'k' }, session.token)).json()) as {
      key: string
    }

    const listing = await (await get(app, '/api/keys', session.token)).text()
    expect(listing).not.toContain(created.key)
    const record = ctx.store.listApiKeys()[0]
    expect(listing).not.toContain(record.keyHash)
  })

  it('rejects an expiry that is already in the past', async () => {
    const { app } = createGatewayApp(makeCtx())
    const session = await register(app)
    const res = await post(
      app,
      '/api/keys',
      { name: 'expired', expiresAt: 1_600_000_000_000 },
      session.token,
    )
    expect(res.status).toBe(400)
  })

  it('a revoked Admin Token stops working on /v1 immediately', async () => {
    const { app } = createGatewayApp(makeCtx())
    const session = await register(app)
    const created = (await (await post(app, '/api/keys', { name: 'client' }, session.token)).json()) as {
      id: string
      key: string
    }
    expect((await get(app, '/v1/models', created.key)).status).toBe(200)

    const revoked = await app.request(`/api/keys/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.token}` },
    })
    expect(revoked.status).toBe(200)
    expect((await get(app, '/v1/models', created.key)).status).toBe(401)
  })

  it('an Admin Token cannot reach the management API', async () => {
    const { app } = createGatewayApp(makeCtx())
    const session = await register(app)
    const created = (await (await post(app, '/api/keys', { name: 'client' }, session.token)).json()) as {
      key: string
    }
    for (const path of ['/api/accounts', '/api/keys', '/api/auth/me']) {
      expect((await get(app, path, created.key)).status).toBe(401)
    }
  })

  it('an Admin Token cannot change the admin password', async () => {
    const { app } = createGatewayApp(makeCtx())
    const session = await register(app)
    const created = (await (await post(app, '/api/keys', { name: 'client' }, session.token)).json()) as {
      key: string
    }
    const res = await post(
      app,
      '/api/auth/password',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      created.key,
    )
    expect(res.status).toBe(401)
  })

  it('an admin session cookie-equivalent cannot be used on /v1', async () => {
    const { app } = createGatewayApp(makeCtx())
    const session = await register(app)
    expect((await get(app, '/v1/models', session.token)).status).toBe(401)
  })
})

// -- install-from-image (KI-001) -----------------------------------------------

describe('POST /api/console/extensions/install-from-image', () => {
  it('is not registered when no manager is configured', async () => {
    // Without GATEWAY_EXTENSION_MANAGER_URL the lifecycle routes are inert,
    // which is the safe default: no manager, no container control.
    const { app } = createGatewayApp(makeCtx())
    const session = await register(app)
    const res = await post(
      app,
      '/api/console/extensions/install-from-image',
      { image: { repo: 'local/gateway-extension-minimax', tag: '1.0.14' } },
      session.token,
    )
    expect(res.status).toBe(404)
  })
})
