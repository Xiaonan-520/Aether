/**
 * Gateway API keys: hashing, CRUD through the admin API, verification, and
 * backward compatibility with the bootstrap GATEWAY_API_KEY.
 *
 * Security assertions are part of the contract: no endpoint may return the
 * full key (after creation) or the stored hash, and audit events must not
 * carry key material.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { createGatewayApp } from '../src/http/app.js'
import { MemoryStore } from '../src/store/memory-store.js'
import { CredentialCipher } from '../src/store/crypto.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { ZCodeCaptchaManager } from '../src/providers/zcode/captcha.js'
import type { ServiceContext } from '../src/service/context.js'
import {
  apiKeyPrefixOf,
  generateApiKey,
  hashApiKey,
  hashEquals,
} from '../src/core/apikeys/hash.js'

const ADMIN = 'adm_test_token'
const BOOTSTRAP = 'gw_bootstrap_key'

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

function adminHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json', ...extra }
}

async function createKey(app: ReturnType<typeof createGatewayApp>['app'], body: unknown = {}) {
  const res = await app.request('/api/keys', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  })
  return { res, json: (await res.json()) as Record<string, unknown> }
}

describe('api key hash module', () => {
  it('generates gw-<prefix8>.<secret32> shaped keys', () => {
    const { key, prefix, hash } = generateApiKey()
    expect(key).toMatch(/^gw-[A-Za-z0-9]{8}\.[A-Za-z0-9]{32}$/)
    expect(apiKeyPrefixOf(key)).toBe(prefix)
    expect(hash).toBe(hashApiKey(key))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces a different key every time', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().key))
    expect(keys.size).toBe(50)
  })

  it('rejects keys that are not shaped like ours', () => {
    for (const bad of ['', 'nope', 'gw-short.x', 'gw-12345678', BOOTSTRAP, 'Bearer gw-12345678.ab']) {
      expect(apiKeyPrefixOf(bad)).toBeNull()
    }
  })

  it('compares hashes without leaking length differences', () => {
    const h = hashApiKey('gw-aaaaaaaa.secret')
    expect(hashEquals(h, h)).toBe(true)
    expect(hashEquals(h, hashApiKey('gw-aaaaaaaa.other'))).toBe(false)
    expect(hashEquals(h, 'abc')).toBe(false)
  })

  it('never stores the plaintext key', () => {
    const { key, hash } = generateApiKey()
    expect(hash).not.toContain(key)
    expect(hash).not.toContain(key.slice(3, 11))
  })
})

describe('POST /api/keys', () => {
  let ctx: ServiceContext
  let app: ReturnType<typeof createGatewayApp>['app']

  beforeEach(() => {
    ctx = makeCtx()
    app = createGatewayApp(ctx).app
  })

  it('requires the admin token', async () => {
    const res = await app.request('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns the full key exactly once', async () => {
    const { res, json } = await createKey(app, { name: 'laptop' })
    expect(res.status).toBe(201)
    expect(json.key).toMatch(/^gw-[A-Za-z0-9]{8}\.[A-Za-z0-9]{32}$/)
    expect(json.name).toBe('laptop')
    expect(typeof json.id).toBe('string')
    expect(json.lastUsedAt).toBeNull()
    expect(json.revokedAt).toBeNull()

    // The listing must not repeat it.
    const listRes = await app.request('/api/keys', { headers: adminHeaders() })
    const listed = (await listRes.json()) as { keys: Record<string, unknown>[] }
    expect(listed.keys).toHaveLength(1)
    expect(listed.keys[0].key).toBeUndefined()
    expect(listed.keys[0].keyHash).toBeUndefined()
  })

  it('defaults the name and rejects a bad expiry', async () => {
    const { json } = await createKey(app, {})
    expect(json.name).toBe('unnamed')

    const bad = await app.request('/api/keys', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ name: 'x', expiresAt: -1 }),
    })
    expect(bad.status).toBe(400)
  })

  it('stores only a hash, never the key', async () => {
    const { json } = await createKey(app, { name: 'audit' })
    const stored = ctx.store.listApiKeys()
    expect(stored).toHaveLength(1)
    expect(stored[0].keyHash).toBe(hashApiKey(String(json.key)))
    expect(stored[0].keyHash).not.toBe(json.key)
    expect(JSON.stringify(stored)).not.toContain(String(json.key).split('.')[1])
  })
})

describe('GET /api/keys', () => {
  it('never exposes the key or the hash', async () => {
    const ctx = makeCtx()
    const app = createGatewayApp(ctx).app
    const { json } = await createKey(app, { name: 'phone' })

    const res = await app.request('/api/keys', { headers: adminHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: unknown[] }
    const text = JSON.stringify(body)
    expect(text).not.toContain(String(json.key))
    expect(text).not.toContain(hashApiKey(String(json.key)))
    expect(body.keys).toHaveLength(1)
  })
})

describe('DELETE /api/keys/:id', () => {
  it('revokes a key so it can no longer authenticate', async () => {
    const ctx = makeCtx()
    const app = createGatewayApp(ctx).app
    const { json } = await createKey(app, { name: 'revoke-me' })
    const key = String(json.key)

    // works before revocation
    const before = await app.request('/v1/models', { headers: { Authorization: `Bearer ${key}` } })
    expect(before.status).toBe(200)

    const del = await app.request(`/api/keys/${json.id}`, { method: 'DELETE', headers: adminHeaders() })
    expect(del.status).toBe(200)

    const after = await app.request('/v1/models', { headers: { Authorization: `Bearer ${key}` } })
    expect(after.status).toBe(401)

    // the row is retained (soft delete) and marked revoked
    const stored = ctx.store.listApiKeys()
    expect(stored[0].enabled).toBe(false)
    expect(stored[0].revokedAt).not.toBeNull()
    expect(app).toBeTruthy()
  })

  it('404s for an unknown id', async () => {
    const ctx = makeCtx()
    const app = createGatewayApp(ctx).app
    const res = await app.request('/api/keys/apikey-nope', { method: 'DELETE', headers: adminHeaders() })
    expect(res.status).toBe(404)
  })
})

describe('/v1 auth', () => {
  it('still accepts the bootstrap GATEWAY_API_KEY (backward compatible)', async () => {
    const ctx = makeCtx()
    const app = createGatewayApp(ctx).app
    const res = await app.request('/v1/models', { headers: { Authorization: `Bearer ${BOOTSTRAP}` } })
    expect(res.status).toBe(200)
  })

  it('accepts an issued key and rejects a forged one', async () => {
    const ctx = makeCtx()
    const app = createGatewayApp(ctx).app
    const { json } = await createKey(app, { name: 'client' })

    const good = await app.request('/v1/models', { headers: { Authorization: `Bearer ${json.key}` } })
    expect(good.status).toBe(200)

    // same prefix, wrong secret
    const forged = String(json.key).replace(/\.[A-Za-z0-9]{32}$/, '.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const bad = await app.request('/v1/models', { headers: { Authorization: `Bearer ${forged}` } })
    expect(bad.status).toBe(401)

    const missing = await app.request('/v1/models')
    expect(missing.status).toBe(401)
  })

  it('rejects an expired key', async () => {
    const ctx = makeCtx(1_700_000_000_000)
    const app = createGatewayApp(ctx).app
    const { json } = await createKey(app, { name: 'expired', expiresAt: 1_699_999_999_999 })
    const res = await app.request('/v1/models', { headers: { Authorization: `Bearer ${json.key}` } })
    expect(res.status).toBe(401)
  })

  it('records last_used_at when a key authenticates', async () => {
    const ctx = makeCtx()
    const app = createGatewayApp(ctx).app
    const { json } = await createKey(app, { name: 'used' })
    await app.request('/v1/models', { headers: { Authorization: `Bearer ${json.key}` } })

    const listRes = await app.request('/api/keys', { headers: adminHeaders() })
    const listed = (await listRes.json()) as { keys: Array<Record<string, unknown>> }
    expect(listed.keys[0].lastUsedAt).toBe(1_700_000_000_000)
  })
})

describe('audit events', () => {
  it('records create, use and revoke without any key material', async () => {
    const ctx = makeCtx()
    const app = createGatewayApp(ctx).app
    const { json } = await createKey(app, { name: 'audited' })
    const key = String(json.key)
    await app.request('/v1/models', { headers: { Authorization: `Bearer ${key}` } })
    await app.request(`/api/keys/${json.id}`, { method: 'DELETE', headers: adminHeaders() })

    const events = ctx.store.listEvents(100)
    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('apikey.created')
    expect(kinds).toContain('apikey.used')
    expect(kinds).toContain('apikey.revoked')

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(key)
    expect(serialized).not.toContain(hashApiKey(key))
    // events reference the id, not the key
    expect(serialized).toContain(String(json.id))
  })
})
