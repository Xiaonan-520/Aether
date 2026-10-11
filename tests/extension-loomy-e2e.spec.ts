/**
 * Loomy Extension E2E — the full protocol surface over real HTTP:
 * manifest/health → SMS login (begin-sms-login → submit-auth-code) → models →
 * chat (JSON + SSE) → quota → claim → refresh semantics → enable/disable.
 * All upstream traffic hits a stub fetcher; no real SMS is ever sent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startLoomyExtension, LOOMY_MANIFEST } from '../src/extensions/loomy/main.js'
import { buildRemoteProviders } from '../src/protocol/extension/remote-provider.js'
import { validateManifest } from '../src/protocol/extension/validate-manifest.js'
import { LOOMY_CHAT_PATH, LOOMY_MODELS_PATH, LOOMY_SEND_CODE_PATH, LOOMY_CHECK_CODE_PATH, LOOMY_POINTS_RECORDS_PATH, LOOMY_FIRST_LOGIN_PATH } from '../src/providers/loomy/product.js'

let upstreamBehavior = { chatStatus: 200, checkCodeOk: true }

const authHeaders = { 'content-type': 'application/json', authorization: 'Bearer e2e-ext-token' }

const upstreamFetch: typeof fetch = async (input) => {
  const path = String(input).replace(/^https:\/\/[^/]+/, '')
  if (path.includes(LOOMY_SEND_CODE_PATH)) {
    return new Response(JSON.stringify({ code: '000000', data: { msgid: 'msg-1' } }), { status: 200 })
  }
  if (path.includes(LOOMY_CHECK_CODE_PATH)) {
    if (!upstreamBehavior.checkCodeOk) {
      return new Response(JSON.stringify({ code: '100002' }), { status: 200 })
    }
    return new Response(JSON.stringify({
      code: '000000',
      data: { session: 'up-session-tok', uid: 'u1', nickname: 'Nina' },
    }), { status: 200 })
  }
  if (path.includes(LOOMY_MODELS_PATH)) {
    return new Response(JSON.stringify({
      code: '000000',
      data: { models: [{ id: 'spark-x2', name: 'Spark X2', type: 'chat' }, { id: 'spark-max', name: 'Spark Max', type: 'chat' }] },
    }), { status: 200 })
  }
  if (path.includes(LOOMY_CHAT_PATH)) {
    if (upstreamBehavior.chatStatus !== 200) return new Response('upstream down', { status: upstreamBehavior.chatStatus })
    const sse = [
      'data: {"choices":[{"delta":{"content":"he"}}]}',
      'data: {"choices":[{"delta":{"content":"y"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  if (path.includes(LOOMY_POINTS_RECORDS_PATH) || path.includes(LOOMY_FIRST_LOGIN_PATH)) {
    return new Response(JSON.stringify({ code: '000000', data: { balance: 88, dailyBalance: 12, availableBalance: 66 } }), { status: 200 })
  }
  return new Response(JSON.stringify({ header: { code: '100001' } }), { status: 404 })
}

const workdir = mkdtempSync(join(tmpdir(), 'gw-loomy-e2e-'))
let ext: Awaited<ReturnType<typeof startLoomyExtension>>

beforeAll(async () => {
  ext = await startLoomyExtension({
    dataDir: join(workdir, 'data'),
    secret: 'e2e-secret-0123456789abcdef',
    fetcher: upstreamFetch,
  })
  process.env.GATEWAY_EXTENSION_TOKEN = 'e2e-ext-token'
})

afterAll(() => {
  delete process.env.GATEWAY_EXTENSION_TOKEN
  ext.server.close()
  rmSync(workdir, { recursive: true, force: true })
})

async function post(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${ext.endpointUrl}${path}`, {
    method: 'POST',
    headers: authHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${ext.endpointUrl}${path}`, { headers: authHeaders })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

/** SMS login: begin (send code) → read detail (still pending) → submit mcode. Idempotent across tests. */
async function provisionActiveAccount(): Promise<string> {
  const existing = await get('/v1/accounts/acc-l1')
  if (existing.status === 200 && (existing.json.account as Record<string, unknown>).status === 'active') return 'acc-l1'
  const created = await post('/v1/accounts', { accountId: 'acc-l1' })
  if (created.status !== 201) throw new Error(`account creation returned ${created.status}`)
  const began = await post('/v1/actions/begin-sms-login', { payload: { phone: '13800000000', account_id: 'acc-l1' } })
  expect((began.json.result as Record<string, unknown>).accepted).toBe(true)
  // detail while pending → needs_manual_action (core poll semantics)
  const pending = await get('/v1/accounts/acc-l1')
  expect((pending.json.account as Record<string, unknown>).status).toBe('needs_manual_action')
  const submitted = await post('/v1/actions/submit-auth-code', { payload: { mcode: '123456', account_id: 'acc-l1' } })
  expect((submitted.json.result as Record<string, unknown>).accepted).toBe(true)
  const { json } = await get('/v1/accounts/acc-l1')
  const account = json.account as Record<string, unknown>
  expect(account).toMatchObject({ accountId: 'acc-l1', status: 'active' })
  return 'acc-l1'
}

describe('loomy extension — manifest and health', () => {
  it('serves a valid manifest and healthy status', async () => {
    const validation = validateManifest(LOOMY_MANIFEST)
    expect(validation.ok).toBe(true)
    const manifest = await fetch(`${ext.endpointUrl}/manifest`).then((r) => r.json())
    expect(manifest).toMatchObject({ extension: { id: 'loomy' } })
    const health = await fetch(`${ext.endpointUrl}/health`).then((r) => r.json())
    expect(health).toMatchObject({ status: 'healthy' })
  })

  it('rejects protocol routes without the extension token', async () => {
    const res = await fetch(`${ext.endpointUrl}/v1/accounts`)
    expect(res.status).toBe(401)
  })

  it('forbids credential fields in account creation (RFC §10.3)', async () => {
    const out = await post('/v1/accounts', { access_token: 'x' })
    expect(out.status).toBe(400)
    expect(JSON.stringify(out.json)).toContain('credential fields are forbidden')
  })
})

describe('loomy extension — SMS login lifecycle', () => {
  it('activates through begin-sms-login → submit-auth-code with no credential in responses', async () => {
    await provisionActiveAccount()
    const { json } = await get('/v1/accounts/acc-l1')
    expect(JSON.stringify(json)).not.toContain('up-session-tok')
    expect(JSON.stringify(json)).not.toContain('access_token')
  })

  it('reports checkCode failures without storing anything', async () => {
    upstreamBehavior.checkCodeOk = false
    try {
      await post('/v1/accounts', { accountId: 'acc-bad' })
      await post('/v1/actions/begin-sms-login', { payload: { phone: '13800000001', account_id: 'acc-bad' } })
      const out = await post('/v1/actions/submit-auth-code', { payload: { mcode: '000000', account_id: 'acc-bad' } })
      expect((out.json.result as Record<string, unknown>).accepted).toBe(false)
      const detail = await get('/v1/accounts/acc-bad')
      // still pending (no store record) — the login did not partially succeed
      expect((detail.json.account as Record<string, unknown>).status).toBe('needs_manual_action')
    } finally {
      upstreamBehavior.checkCodeOk = true
    }
  })

  it('accepts a ready session blob via the action channel', async () => {
    const out = await post('/v1/actions/submit-auth-code', {
      payload: { access_token: 'imported-tok', expires_at: String(Date.now() + 3_600_000), account_id: 'acc-imp' },
    })
    expect((out.json.result as Record<string, unknown>).accepted).toBe(true)
    const { json } = await get('/v1/accounts/acc-imp')
    expect((json.account as Record<string, unknown>).status).toBe('active')
  })
})

describe('loomy extension — models, chat, quota, claim', () => {
  it('lists remote catalog models with bare upstream ids', async () => {
    await provisionActiveAccount()
    const { json } = await get('/v1/models')
    const models = json.models as Array<{ id: string }>
    expect(models.map((m) => m.id)).toContain('spark-x2')
  })

  it('aggregates a non-stream chat and strips the namespace prefix upstream', async () => {
    await provisionActiveAccount()
    const { status, json } = await post('/v1/chat', {
      accountId: 'acc-l1',
      model: 'loomy::spark-x2', // namespaced in; bare upstream
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(status).toBe(200)
    expect(json).toMatchObject({ content: 'hey', finishReason: 'stop' })
  })

  it('streams chunks as SSE chunk events', async () => {
    await provisionActiveAccount()
    const res = await fetch(`${ext.endpointUrl}/v1/chat`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ accountId: 'acc-l1', model: 'spark-x2', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('event: chunk')
    expect(text).toContain('"finishReason":"stop"')
  })

  it('maps upstream chat failures to structured errors', async () => {
    await provisionActiveAccount()
    upstreamBehavior.chatStatus = 500
    try {
      const { status, json } = await post('/v1/chat', { accountId: 'acc-l1', model: 'm', messages: [], stream: false })
      expect(status).toBe(502)
      expect((json.error as Record<string, unknown>).kind).toBe('UPSTREAM_5XX')
    } finally {
      upstreamBehavior.chatStatus = 200
    }
  })

  it('projects the upstream quota and reports needs_auth on claim without credential', async () => {
    await provisionActiveAccount()
    const { json } = await get('/v1/accounts/acc-l1/quota')
    const quota = json as { resources: Array<{ id: string; remaining: number }> }
    expect(quota.resources[0]).toMatchObject({ id: 'credits', remaining: 66 })
    const noCred = await post('/v1/accounts/acc-none/claim')
    expect((noCred.json.outcome as Record<string, unknown>).kind).toBe('needs_auth')
  })

  it('refresh is honestly not-refreshable (no fake success)', async () => {
    await provisionActiveAccount()
    const { json } = await post('/v1/accounts/acc-l1/refresh')
    expect(json).toMatchObject({ refreshed: false })
    expect(String(json.error)).toContain('no refresh endpoint')
  })
})

describe('loomy extension — Core RemoteProvider seam', () => {
  it('mounts as a remote provider with namespaced model ids', async () => {
    await provisionActiveAccount()
    const [provider] = buildRemoteProviders({
      manifest: structuredClone(LOOMY_MANIFEST),
      endpoints: { baseUrl: ext.endpointUrl, token: 'e2e-ext-token' },
    })
    expect(provider.id).toBe('loomy')
    const models = await provider.chat.listModels(
      { provider: 'loomy', resolveCredential: async () => undefined },
      { id: 'acc-l1', provider: 'loomy', displayName: 'x', status: 'active', enabled: true, authenticated: true, tokenExpiryAt: null, refreshable: false, credentialKey: 'CRED', failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null, modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null, quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0 },
    )
    expect(models.map((m) => m.modelId)).toEqual(['loomy::spark-x2', 'loomy::spark-max'])
  })
})
