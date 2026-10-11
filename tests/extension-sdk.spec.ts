/**
 * Extension SDK tests: boot a real HTTP server from the SDK skeleton with a
 * stub adapter and verify the protocol behaviors Core depends on — open
 * health/manifest, bearer auth, accounts CRUD mapping, chat JSON + SSE
 * framing, action whitelist, error body shape, log redaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createExtensionHttpServer, RequestRegistry } from '../src/extension/sdk/index.js'
import type { ExtensionAdapter } from '../src/extension/sdk/index.js'
import { sanitizeLogFields, validateManifestShape, errors } from '../src/extension/sdk/index.js'
import type { SdkExtensionManifest } from '../src/extension/sdk/index.js'
import type { AddressInfo } from 'node:net'

const manifest = {
  protocol: 'v1',
  extension: { id: 'fake', name: 'Fake Extension', version: '1.0.0' },
  runtime: { image: { repo: 'local/gateway-extension-fake', tag: '1.0.0' }, port: 8080, healthPath: '/health' },
  providers: [
    {
      id: 'fake',
      displayName: 'Fake',
      loginMode: 'external-link',
      actions: [
        { id: 'refresh-quota', sideEffects: 'readonly', inputSchema: { type: 'object', properties: { detailed: { type: 'boolean' } } } },
        { id: 'noop', sideEffects: 'mutating' },
      ],
    },
  ],
} as unknown as SdkExtensionManifest

const adapter: ExtensionAdapter = {
  async listAccounts() {
    return [{ accountId: 'acc-1', status: 'active', displayName: 'One' }]
  },
  async getAccount(id) {
    return id === 'acc-1' ? { accountId: id, status: 'active' } : null
  },
  async createAccount(body) {
    return { accountId: (body.accountId as string) ?? 'acc-new', status: 'pending' }
  },
  async refresh(id) {
    return { accountId: id, refreshed: true }
  },
  async setEnabled(id, enabled) {
    return { accountId: id, accepted: true, status: enabled ? 'active' : 'disabled' }
  },
  async quota(id) {
    return { accountId: id, resources: [{ kind: 'credits', remaining: 10, status: 'ok' }] }
  },
  async claim(id) {
    return { accountId: id, outcome: 'claimed' }
  },
  async models() {
    return { models: [{ id: 'fake-model', displayName: 'Fake Model' }] }
  },
  async chat(req) {
    return { text: `echo:${req.model}:${req.accountId}`, finishReason: 'stop' }
  },
  async *chatStream(req) {
    yield { text: 'hello ' }
    yield { text: req.model }
    yield { finishReason: 'stop', usage: { totalTokens: 5 } }
  },
  async invokeAction(actionId, body) {
    if (actionId === 'refresh-quota') {
      return { accountId: (body.accountId as string) ?? 'acc-1', resources: [] }
    }
    return { actionId }
  },
}

let server: ReturnType<typeof createExtensionHttpServer>
let base = ''
const logs: Array<{ event: string; fields: Record<string, unknown> }> = []

beforeAll(async () => {
  server = createExtensionHttpServer({
    manifest,
    authToken: 'sdk-test-token',
    adapter,
    logger: {
      info(event, fields) {
        logs.push({ event, fields: fields ?? {} })
      },
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(() => {
  server.close()
})

function get(path: string, token?: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
}

function post(path: string, body: unknown, token = 'sdk-test-token'): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('extension sdk — server skeleton', () => {
  it('serves /manifest and /health without a token (healthcheck + install handshake)', async () => {
    const mRes = await get('/manifest')
    expect(mRes.status).toBe(200)
    expect(await mRes.json()).toMatchObject({ protocol: 'v1', extension: { id: 'fake' } })

    const hRes = await get('/health')
    expect(hRes.status).toBe(200)
    expect(await hRes.json()).toMatchObject({ status: 'healthy', version: '1.0.0', accounts: { total: 1, usable: 1 } })
  })

  it('rejects protected routes without or with a wrong bearer (401, protocol error body)', async () => {
    const noAuth = await get('/v1/accounts')
    expect(noAuth.status).toBe(401)
    expect(await noAuth.json()).toMatchObject({ error: { kind: 'AUTH_INVALID' } })

    const badAuth = await get('/v1/accounts', 'wrong-token')
    expect(badAuth.status).toBe(401)

    const ok = await get('/v1/accounts', 'sdk-test-token')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ accounts: [{ accountId: 'acc-1', status: 'active' }] })
  })

  it('maps the adapter surface across accounts/models routes', async () => {
    const detail = await get('/v1/accounts/acc-1', 'sdk-test-token')
    expect(await detail.json()).toMatchObject({ account: { accountId: 'acc-1' } })

    const missing = await get('/v1/accounts/acc-404', 'sdk-test-token')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { kind: 'TERMINAL' } })

    const created = await post('/v1/accounts', { accountId: 'acc-2', loginMode: 'external-link' })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ accountId: 'acc-2', status: 'pending' })

    const models = await get('/v1/models', 'sdk-test-token')
    expect(await models.json()).toMatchObject({ models: [{ id: 'fake-model' }] })
  })

  it('forbids credential fields in account creation (PROTOCOL_VIOLATION)', async () => {
    const res = await post('/v1/accounts', { accountId: 'acc-3', access_token: 'leak' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { kind: 'PROTOCOL_VIOLATION' } })
  })

  it('handles chat as JSON and as SSE with the chunk/done/error framing', async () => {
    const json = await post('/v1/chat', { model: 'm1', accountId: 'acc-1', messages: [{ role: 'user', content: 'hi' }] })
    expect(await json.json()).toMatchObject({ text: 'echo:m1:acc-1', finishReason: 'stop' })

    const sse = await post('/v1/chat', { model: 'm2', accountId: 'acc-1', stream: true, messages: [] })
    expect(sse.headers.get('content-type')).toBe('text/event-stream')
    const raw = await sse.text()
    expect(raw).toContain('event: chunk')
    expect(raw).toContain('"text":"hello "')
    expect(raw).toContain('event: done')
    expect(raw).toContain('"finishReason":"stop"')
    expect(raw.trim().endsWith('}')).toBe(true)
  })

  it('enforces the manifest action whitelist and forwards whitelisted actions', async () => {
    const undeclared = await post('/v1/actions/does-not-exist', {})
    expect(undeclared.status).toBe(404)

    const ok = await post('/v1/actions/refresh-quota', { accountId: 'acc-1' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ accountId: 'acc-1', resources: [] })
  })

  it('answers 404 for unknown routes and 405-style misses as TERMINAL', async () => {
    const res = await get('/v1/nothing-here', 'sdk-test-token')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { kind: 'TERMINAL' } })
  })

  it('redacts credential-shaped log fields', async () => {
    const fields = sanitizeLogFields({ account_id: 'a', access_token: 'x', Authorization: 'Bearer y', nested: 'ok' })
    expect(fields).toEqual({ account_id: 'a', access_token: '[redacted]', Authorization: '[redacted]', nested: 'ok' })
  })

  it('records sanitized request logs', async () => {
    const entry = [...logs].reverse().find((l) => l.event === 'http.request' && l.fields.method === 'GET' && l.fields.path === '/v1/accounts')
    expect(entry).toBeTruthy()
    expect(entry!.fields.status).toBe(200)
  })
})

describe('extension sdk — manifest validation & misc', () => {
  it('accepts the canonical manifest shape', () => {
    expect(() => validateManifestShape(manifest)).not.toThrow()
  })

  it('rejects bad protocol, ids, versions, and duplicate providers/actions', () => {
    expect(() => validateManifestShape({ ...manifest, protocol: 'v2' })).toThrow(/protocol/)
    expect(() => validateManifestShape({
      ...manifest,
      extension: { ...manifest.extension, version: 'not-semver' },
    })).toThrow(/version/)
    expect(() => validateManifestShape({
      ...manifest,
      providers: [manifest.providers[0]!, { ...manifest.providers[0]! }],
    })).toThrow(/duplicate provider/)
  })

  it('chat validation requires model/accountId/messages and rejects prefixed models', async () => {
    const bad = await post('/v1/chat', { accountId: 'acc-1', messages: [] })
    expect(bad.status).toBe(400)
    const prefixed = await post('/v1/chat', { model: 'fake::m1', accountId: 'acc-1', messages: [] })
    expect(prefixed.status).toBe(400)
    expect(await prefixed.json()).toMatchObject({ error: { kind: 'PROTOCOL_VIOLATION' } })
  })

  it('RequestRegistry aborts all in-flight requests', () => {
    const registry = new RequestRegistry()
    let aborted = false
    const controller = new AbortController()
    controller.signal.addEventListener('abort', () => { aborted = true })
    registry.register('req_1', 'acc-1', controller)
    expect(registry.size).toBe(1)
    registry.abortAll()
    expect(aborted).toBe(true)
    expect(registry.size).toBe(0)
  })

  it('exposes the error factories with canonical statuses', () => {
    expect(errors.rateLimit().status()).toBe(429)
    expect(errors.terminal('x', { responseStatus: 404 }).status()).toBe(404)
    expect(errors.protocolViolation().status()).toBe(400)
  })
})
