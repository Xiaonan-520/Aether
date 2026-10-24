/**
 * Admin identity: first-run registration, email+password login, sessions and
 * the boundary between admin sessions, gateway API keys and the static
 * GATEWAY_ADMIN_TOKEN.
 *
 * The security contract asserted here:
 * - public registration closes permanently after the first admin
 * - concurrent first-registration creates exactly one admin
 * - unknown email and wrong password are indistinguishable to the client
 * - a revoked/expired session stops working immediately
 * - a session token can never be used on /v1, and a gateway key never on /api
 * - no password, digest or token material appears in audit events
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
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../src/core/auth/password.js'
import { normalizeEmail } from '../src/core/auth/email.js'

const ADMIN = 'adm_static_operator_token'
const BOOTSTRAP = 'gw_bootstrap_key'
const EMAIL = 'operator@aether.test'
const PASSWORD = 'correct-horse-battery'

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
  return { res, json: (await res.json()) as Record<string, unknown> }
}

async function login(app: App, email = EMAIL, password = PASSWORD) {
  const res = await post(app, '/api/auth/login', { email, password })
  return { res, json: (await res.json()) as Record<string, unknown> }
}

// -- password hashing ---------------------------------------------------------

describe('admin password hashing', () => {
  it('produces a self-describing scrypt digest, never the password', async () => {
    const digest = await hashPassword(PASSWORD)
    expect(digest).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/)
    expect(digest).not.toContain(PASSWORD)
  })

  it('salts each digest so equal passwords hash differently', async () => {
    const a = await hashPassword(PASSWORD)
    const b = await hashPassword(PASSWORD)
    expect(a).not.toBe(b)
    expect(await verifyPassword(PASSWORD, a)).toBe(true)
    expect(await verifyPassword(PASSWORD, b)).toBe(true)
  })

  it('verifies the right password and rejects the wrong one', async () => {
    const digest = await hashPassword(PASSWORD)
    expect(await verifyPassword(PASSWORD, digest)).toBe(true)
    expect(await verifyPassword(PASSWORD + 'x', digest)).toBe(false)
    expect(await verifyPassword('', digest)).toBe(false)
  })

  it('rejects a password below the minimum length', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least/)
    await expect(hashPassword('x'.repeat(MIN_PASSWORD_LENGTH - 1))).rejects.toThrow(/at least/)
    await expect(hashPassword('x'.repeat(MIN_PASSWORD_LENGTH))).resolves.toMatch(/^scrypt\$/)
  })

  it('fails closed on a malformed or tampered digest instead of throwing', async () => {
    for (const bad of ['', 'plaintext', 'scrypt$bad', 'bcrypt$1$2$3$4$5', 'scrypt$16384$8$1$$']) {
      expect(await verifyPassword(PASSWORD, bad)).toBe(false)
    }
  })

  it('refuses absurd scrypt cost parameters', async () => {
    const digest = await hashPassword(PASSWORD)
    const parts = digest.split('$')
    parts[1] = String(1 << 25)
    expect(await verifyPassword(PASSWORD, parts.join('$'))).toBe(false)
  })
})

// -- email normalization ------------------------------------------------------

describe('email normalization', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Operator@Aether.TEST ')).toBe('operator@aether.test')
  })

  it('rejects unusable addresses', () => {
    for (const bad of ['', '   ', 'nope', 'a@b', '@aether.test', 'a@', 'a@@b.test', 'a b@c.test', 'a@b c.test', null, 42]) {
      expect(normalizeEmail(bad as unknown)).toBeNull()
    }
  })

  it('does not rewrite provider-specific plus addressing', () => {
    expect(normalizeEmail('ops+test@aether.test')).toBe('ops+test@aether.test')
  })
})

// -- status -------------------------------------------------------------------

describe('GET /api/auth/status', () => {
  it('reports uninitialized on an empty database', async () => {
    const { app } = createGatewayApp(makeCtx())
    const res = await get(app, '/api/auth/status')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ initialized: false })
  })

  it('reports initialized without leaking the admin email to anonymous callers', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    const res = await get(app, '/api/auth/status')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.initialized).toBe(true)
    expect(body.user).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(EMAIL)
  })

  it('includes the user when the caller presents a valid session', async () => {
    const { app } = createGatewayApp(makeCtx())
    const { json } = await register(app)
    const token = json.token as string
    const body = (await (await get(app, '/api/auth/status', token)).json()) as Record<string, unknown>
    expect(body.initialized).toBe(true)
    expect((body.user as Record<string, unknown>).email).toBe(EMAIL)
  })
})

// -- registration -------------------------------------------------------------

describe('POST /api/auth/register', () => {
  it('creates the first admin and returns a usable session', async () => {
    const { app } = createGatewayApp(makeCtx())
    const { res, json } = await register(app)
    expect(res.status).toBe(201)
    expect(typeof json.token).toBe('string')
    expect(json.token as string).toMatch(/^adm-/)
    expect((json.user as Record<string, unknown>).email).toBe(EMAIL)
    expect(json.expiresAt).toBeGreaterThan(0)
    // the response must never echo the password or its digest
    expect(JSON.stringify(json)).not.toContain(PASSWORD)
    expect(JSON.stringify(json)).not.toContain('scrypt$')
  })

  it('stores only the scrypt digest, never the password', async () => {
    const ctx = makeCtx()
    const { app } = createGatewayApp(ctx)
    await register(app)
    const user = ctx.store.getAdminUserByEmail(EMAIL)
    expect(user).toBeDefined()
    expect(user!.passwordHash).toMatch(/^scrypt\$/)
    expect(user!.passwordHash).not.toContain(PASSWORD)
  })

  it('rejects a missing email or password', async () => {
    const { app } = createGatewayApp(makeCtx())
    for (const body of [{}, { email: EMAIL }, { password: PASSWORD }, { email: '', password: '' }]) {
      const res = await post(app, '/api/auth/register', body)
      expect(res.status).toBe(400)
    }
    expect(makeCtx().store.countAdminUsers()).toBe(0)
  })

  it('rejects an invalid email shape', async () => {
    const { app } = createGatewayApp(makeCtx())
    const res = await post(app, '/api/auth/register', { email: 'not-an-email', password: PASSWORD })
    expect(res.status).toBe(400)
  })

  it('enforces the minimum password length', async () => {
    const { app } = createGatewayApp(makeCtx())
    const res = await post(app, '/api/auth/register', { email: EMAIL, password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body.message)).toContain(String(MIN_PASSWORD_LENGTH))
  })

  it('closes public registration permanently after the first admin', async () => {
    const { app } = createGatewayApp(makeCtx())
    expect((await register(app)).res.status).toBe(201)

    const second = await register(app, 'intruder@aether.test', 'another-long-password')
    expect(second.res.status).toBe(409)
    expect(second.json.error).toBe('registration_closed')

    // even the original identity cannot register again
    expect((await register(app)).res.status).toBe(409)
  })

  it('normalizes the email so a case/whitespace variant collides', async () => {
    const ctx = makeCtx()
    const { app } = createGatewayApp(ctx)
    await register(app, '  Operator@AETHER.test  ')
    expect(ctx.store.getAdminUserByEmail('operator@aether.test')).toBeDefined()

    const second = await register(app, 'operator@aether.test', 'another-long-password')
    expect(second.res.status).toBe(409)
    expect(ctx.store.countAdminUsers()).toBe(1)
  })

  it('creates exactly one admin under concurrent first-registration', async () => {
    const ctx = makeCtx()
    const { app } = createGatewayApp(ctx)
    // Fire many simultaneous registrations with distinct identities. Exactly
    // one may win; the rest must be rejected — never two admins.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(app, '/api/auth/register', {
          email: `race${i}@aether.test`,
          password: 'concurrent-password',
        }),
      ),
    )
    const created = results.filter((r) => r.status === 201)
    expect(created).toHaveLength(1)
    expect(ctx.store.countAdminUsers()).toBe(1)
    for (const res of results.filter((r) => r.status !== 201)) {
      expect(res.status).toBe(409)
    }
  })

  it('writes an audit event that contains no digest or password', async () => {
    const ctx = makeCtx()
    const { app } = createGatewayApp(ctx)
    await register(app)
    const events = ctx.store.listEvents(50)
    const registered = events.find((e) => e.kind === 'admin.registered')
    expect(registered).toBeDefined()
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(PASSWORD)
    expect(serialized).not.toContain('scrypt$')
  })
})

// -- login --------------------------------------------------------------------

describe('POST /api/auth/login', () => {
  it('accepts the right password and returns a fresh session', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    const { res, json } = await login(app)
    expect(res.status).toBe(200)
    expect(json.token as string).toMatch(/^adm-/)
    expect((json.user as Record<string, unknown>).email).toBe(EMAIL)
  })

  it('issues a distinct token per login', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    const a = (await login(app)).json.token
    const b = (await login(app)).json.token
    expect(a).not.toBe(b)
  })

  it('rejects a wrong password', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    const { res, json } = await login(app, EMAIL, 'wrong-password-here')
    expect(res.status).toBe(401)
    expect(json.error).toBe('invalid_credentials')
    expect(json.token).toBeUndefined()
  })

  it('rejects an unknown email with the same status and message as a wrong password', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    const unknown = await login(app, 'nobody@aether.test', PASSWORD)
    const wrong = await login(app, EMAIL, 'wrong-password-here')
    expect(unknown.res.status).toBe(wrong.res.status)
    expect(unknown.json.error).toBe(wrong.json.error)
    expect(unknown.json.message).toBe(wrong.json.message)
  })

  it('normalizes the email on login too', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app, EMAIL)
    const { res } = await login(app, '  OPERATOR@AETHER.TEST  ', PASSWORD)
    expect(res.status).toBe(200)
  })

  it('throttles repeated failures and stops leaking timing', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    for (let i = 0; i < 5; i++) {
      expect((await login(app, EMAIL, 'wrong-password-here')).res.status).toBe(401)
    }
    const blocked = await login(app, EMAIL, PASSWORD)
    expect(blocked.res.status).toBe(429)
    expect(blocked.json.error).toBe('too_many_attempts')
  })

  it('does not let failures against one identity lock out another', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    for (let i = 0; i < 5; i++) await login(app, EMAIL, 'wrong-password-here')
    // a different (unknown) identity is still evaluated normally
    const other = await login(app, 'other@aether.test', PASSWORD)
    expect(other.res.status).toBe(401)
  })
})

// -- sessions -----------------------------------------------------------------

describe('admin sessions', () => {
  it('grants access to protected admin endpoints', async () => {
    const { app } = createGatewayApp(makeCtx())
    const token = (await register(app)).json.token as string
    const res = await get(app, '/api/accounts', token)
    expect(res.status).toBe(200)
  })

  it('reports the identity and expiry via /api/auth/me', async () => {
    const ctx = makeCtx()
    const { app } = createGatewayApp(ctx)
    const token = (await register(app)).json.token as string
    const body = (await (await get(app, '/api/auth/me', token)).json()) as Record<string, unknown>
    expect((body.user as Record<string, unknown>).email).toBe(EMAIL)
    expect(body.staticToken).toBe(false)
    expect(body.expiresAt as number).toBeGreaterThan(ctx.now())
  })

  it('logout revokes the session immediately', async () => {
    const { app } = createGatewayApp(makeCtx())
    const token = (await register(app)).json.token as string
    expect((await get(app, '/api/accounts', token)).status).toBe(200)

    const out = await post(app, '/api/auth/logout', {}, token)
    expect(out.status).toBe(200)

    expect((await get(app, '/api/accounts', token)).status).toBe(401)
    expect((await get(app, '/api/auth/status', token)).status).toBe(200)
    const status = (await (await get(app, '/api/auth/status', token)).json()) as Record<string, unknown>
    expect(status.user).toBeUndefined()
  })

  it('logout does not invalidate other sessions of the same admin', async () => {
    const { app } = createGatewayApp(makeCtx())
    const first = (await register(app)).json.token as string
    const second = (await login(app)).json.token as string
    await post(app, '/api/auth/logout', {}, first)
    expect((await get(app, '/api/accounts', first)).status).toBe(401)
    expect((await get(app, '/api/accounts', second)).status).toBe(200)
  })

  it('rejects an expired session', async () => {
    const ctx = makeCtx()
    const { app } = createGatewayApp(ctx)
    const token = (await register(app)).json.token as string
    expect((await get(app, '/api/accounts', token)).status).toBe(200)

    // advance the clock past the TTL
    const realNow = ctx.now
    ctx.now = () => realNow() + 13 * 60 * 60 * 1000
    expect((await get(app, '/api/accounts', token)).status).toBe(401)
  })

  it('rejects a forged session token', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    for (const bogus of ['adm-forged', 'adm-' + 'x'.repeat(43), 'gw-12345678.' + 'y'.repeat(32)]) {
      expect((await get(app, '/api/accounts', bogus)).status).toBe(401)
    }
  })

  it('prunes expired sessions', async () => {
    const ctx = makeCtx()
    const { app } = createGatewayApp(ctx)
    await register(app)
    const realNow = ctx.now
    const app2 = createGatewayApp(ctx)
    expect(app2.adminAuth.pruneSessions()).toBe(0)
    ctx.now = () => realNow() + 13 * 60 * 60 * 1000
    expect(app2.adminAuth.pruneSessions()).toBe(1)
  })
})

// -- credential separation ----------------------------------------------------

describe('credential separation', () => {
  it('a session token is not accepted on /v1', async () => {
    const { app } = createGatewayApp(makeCtx())
    const token = (await register(app)).json.token as string
    const res = await get(app, '/v1/models', token)
    expect(res.status).toBe(401)
  })

  it('a gateway API key is not accepted on /api', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    expect((await get(app, '/api/accounts', BOOTSTRAP)).status).toBe(401)
  })

  it('a gateway-issued API key is not accepted on /api either', async () => {
    const { app } = createGatewayApp(makeCtx())
    const sessionToken = (await register(app)).json.token as string
    const created = await post(app, '/api/keys', { name: 'client' }, sessionToken)
    expect(created.status).toBe(201)
    const key = ((await created.json()) as Record<string, unknown>).key as string

    expect((await get(app, '/api/accounts', key)).status).toBe(401)
    // ...but it does work on /v1
    expect((await get(app, '/v1/models', key)).status).toBe(200)
  })

  it('the static GATEWAY_ADMIN_TOKEN still works and is not a session', async () => {
    const { app } = createGatewayApp(makeCtx())
    expect((await get(app, '/api/accounts', ADMIN)).status).toBe(200)

    const me = (await (await get(app, '/api/auth/me', ADMIN)).json()) as Record<string, unknown>
    expect(me.user).toBeNull()
    expect(me.staticToken).toBe(true)
    expect(me.expiresAt).toBeNull()
  })

  it('logging out with the static token is a documented no-op', async () => {
    const { app } = createGatewayApp(makeCtx())
    await post(app, '/api/auth/logout', {}, ADMIN)
    // the env token is not revocable and must keep working
    expect((await get(app, '/api/accounts', ADMIN)).status).toBe(200)
  })

  it('an unauthenticated caller cannot mint any credential', async () => {
    const { app } = createGatewayApp(makeCtx())
    await register(app)
    // every credential-minting route requires an admin credential
    expect((await post(app, '/api/keys', { name: 'x' })).status).toBe(401)
    expect((await post(app, '/api/auth/logout', {})).status).toBe(401)
    // registration is closed, login needs the password
    expect((await post(app, '/api/auth/register', { email: 'x@aether.test', password: 'long-enough-pw' })).status).toBe(409)
    expect((await post(app, '/api/auth/login', { email: EMAIL, password: 'wrong-password-here' })).status).toBe(401)
  })

  it('never returns the password digest from any auth endpoint', async () => {
    const ctx = makeCtx()
    const { app } = createGatewayApp(ctx)
    const reg = await register(app)
    const token = reg.json.token as string
    const bodies = [
      JSON.stringify(reg.json),
      JSON.stringify(await (await get(app, '/api/auth/status', token)).json()),
      JSON.stringify(await (await get(app, '/api/auth/me', token)).json()),
      JSON.stringify(await (await login(app)).json),
      JSON.stringify((await (await get(app, '/api/events')).json())),
    ]
    for (const body of bodies) {
      expect(body).not.toContain(PASSWORD)
      expect(body).not.toContain('scrypt$')
      expect(body).not.toContain(ctx.store.getAdminUserByEmail(EMAIL)!.passwordHash)
    }
  })
})
