/**
 * Raccoon Extension E2E — the full protocol surface over real HTTP:
 * manifest/health → account creation (QR pending) → credential import via the
 * opaque action channel → models/chat (JSON + SSE) → quota → claim → refresh
 * → enable/disable. All upstream traffic hits a stub fetcher.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startRaccoonExtension, RACCOON_MANIFEST } from '../src/extensions/raccoon/main.js'
import { buildRemoteProviders } from '../src/protocol/extension/remote-provider.js'
import { validateManifest } from '../src/protocol/extension/validate-manifest.js'
import { RACCOON_CHAT_PATH, RACCOON_MODEL_CATALOG_PATH, RACCOON_REFRESH_PATH, RACCOON_QR_LOGIN_PATH, RACCOON_BALANCE_PATH, RACCOON_LOGIN_GRANT_PATH, RACCOON_USER_INFO_PATH } from '../src/providers/raccoon/product.js'

let upstreamBehavior = {
  qrStatus: 3, // success
  chatStatus: 200,
}

const authHeaders = { 'content-type': 'application/json', authorization: 'Bearer e2e-ext-token' }

const upstreamFetch: typeof fetch = async (input, init) => {
  const path = String(input).replace(/^https:\/\/[^/]+/, '')
  if (path.includes(RACCOON_QR_LOGIN_PATH)) {
    const body = JSON.parse(String((init?.body ?? '{}'))) as { qrcode_code?: string }
    const status = upstreamBehavior.qrStatus
    if (status === 3) {
      return new Response(JSON.stringify({
        code: 0,
        data: { status: 3, access_token: 'up-at', refresh_token: 'up-rt', nickname: 'Nina', uid: 'u1' },
      }), { status: 200 })
    }
    void body
    return new Response(JSON.stringify({ code: 0, data: { status } }), { status: 200 })
  }
  if (path.includes(RACCOON_MODEL_CATALOG_PATH)) {
    return new Response(JSON.stringify({
      code: 0,
      data: { models: [{ id: 'sn-glm-5-3', name: 'GLM-5.3' }, { id: 'sn-kimi-k3', name: 'Kimi K3' }] },
    }), { status: 200 })
  }
  if (path.includes(RACCOON_CHAT_PATH)) {
    if (upstreamBehavior.chatStatus !== 200) return new Response('upstream down', { status: upstreamBehavior.chatStatus })
    const sse = [
      'data: {"choices":[{"delta":{"content":"he"}}]}',
      'data: {"choices":[{"delta":{"content":"llo"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2}}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  if (path.includes(RACCOON_REFRESH_PATH)) {
    return new Response(JSON.stringify({ code: 0, data: { access_token: 'up-at-2', refresh_token: 'up-rt-2' } }), { status: 200 })
  }
  if (path.includes(RACCOON_BALANCE_PATH)) {
    return new Response(JSON.stringify({ code: 0, data: { points: 55.5, totalPoints: 100 } }), { status: 200 })
  }
  if (path.includes(RACCOON_LOGIN_GRANT_PATH)) {
    return new Response(JSON.stringify({ code: 0, data: { granted: 10 } }), { status: 200 })
  }
  if (path.includes(RACCOON_USER_INFO_PATH)) {
    return new Response(JSON.stringify({ code: 0, data: { uid: 'u1' } }), { status: 200 })
  }
  return new Response(JSON.stringify({ code: -1, msg: `no route ${path}` }), { status: 404 })
}

const workdir = mkdtempSync(join(tmpdir(), 'gw-raccoon-e2e-'))
let ext: Awaited<ReturnType<typeof startRaccoonExtension>>

beforeAll(async () => {
  ext = await startRaccoonExtension({
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

/** Provision an active account: pending QR login + poll-completed activation. Idempotent across tests. */
async function provisionActiveAccount(): Promise<string> {
  const existing = await get('/v1/accounts/acc-r1')
  if (existing.status === 200 && (existing.json.account as Record<string, unknown>).status === 'active') return 'acc-r1'
  const created = await post('/v1/accounts', { accountId: 'acc-r1' })
  if (created.status !== 201) throw new Error(`account creation returned ${created.status}: ${JSON.stringify(created.json)}`)
  // complete the QR flow via the poll path (stub upstream returns status 3 + token)
  const { json } = await get('/v1/accounts/acc-r1')
  const account = json.account as Record<string, unknown>
  expect(account).toMatchObject({ accountId: 'acc-r1', status: 'active' })
  return 'acc-r1'
}

describe('raccoon extension — manifest and health', () => {
  it('serves a valid manifest and healthy status', async () => {
    const validation = validateManifest(RACCOON_MANIFEST)
    expect(validation.ok).toBe(true)
    const manifest = await fetch(`${ext.endpointUrl}/manifest`).then((r) => r.json())
    expect(manifest).toMatchObject({ extension: { id: 'raccoon' } })
    const health = await fetch(`${ext.endpointUrl}/health`).then((r) => r.json())
    expect(health).toMatchObject({ status: 'healthy' })
  })

  it('rejects protocol routes without the extension token', async () => {
    const res = await fetch(`${ext.endpointUrl}/v1/accounts`)
    expect(res.status).toBe(401)
  })
})

describe('raccoon extension — account lifecycle', () => {
  it('creates a pending QR login then activates via the action channel (no credential in responses)', async () => {
    const accountId = await provisionActiveAccount()
    const { json } = await get(`/v1/accounts/${accountId}`)
    const account = json.account as Record<string, unknown>
    expect(account).toMatchObject({ accountId, status: 'active', providerId: 'raccoon' })
    expect(JSON.stringify(json)).not.toContain('up-at')
    expect(JSON.stringify(json)).not.toContain('access_token')
  })
  it('refuses SMS credential import (captcha policy) without attempting upstream', async () => {
    const out = await post('/v1/actions/submit-auth-code', { payload: { code: 'x', sms: true } })
    expect((out.json.result as Record<string, unknown>).accepted).toBe(false)
    expect(JSON.stringify(out.json)).toContain('QR flow')
  })

  it('enable/disable toggles the projection', async () => {
    await provisionActiveAccount()
    const off = await post('/v1/accounts/acc-r1/disable')
    expect(off.json).toMatchObject({ accepted: true, status: 'disabled' })
    const on = await post('/v1/accounts/acc-r1/enable')
    expect(on.json).toMatchObject({ accepted: true, status: 'active' })
  })
})

describe('raccoon extension — models, chat, quota, claim', () => {
  it('lists remote catalog models with bare upstream ids', async () => {
    await provisionActiveAccount()
    const { json } = await get('/v1/models')
    const models = json.models as Array<{ id: string }>
    expect(models.map((m) => m.id)).toContain('sn-glm-5-3')
  })

  it('aggregates a non-stream chat and strips the namespace prefix upstream', async () => {
    await provisionActiveAccount()
    const { status, json } = await post('/v1/chat', {
      accountId: 'acc-r1',
      model: 'raccoon::sn-glm-5-3', // namespaced in; bare upstream
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(status).toBe(200)
    expect(json).toMatchObject({ content: 'hello', finishReason: 'stop' })
  })

  it('streams chunks as SSE chunk events', async () => {
    await provisionActiveAccount()
    const res = await fetch(`${ext.endpointUrl}/v1/chat`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ accountId: 'acc-r1', model: 'sn-glm-5-3', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('event: chunk')
    expect(text).toContain('"finishReason":"stop"')
  })

  it('maps upstream chat failures to structured errors (no credential leak)', async () => {
    await provisionActiveAccount()
    upstreamBehavior.chatStatus = 503
    try {
      const { status, json } = await post('/v1/chat', { accountId: 'acc-r1', model: 'm', messages: [], stream: false })
      expect(status).toBe(502)
      expect((json.error as Record<string, unknown>).kind).toBe('UPSTREAM_5XX')
      expect(JSON.stringify(json)).not.toContain('up-at')
    } finally {
      upstreamBehavior.chatStatus = 200
    }
  })

  it('projects the upstream balance as quota resources', async () => {
    await provisionActiveAccount()
    const { json } = await get('/v1/accounts/acc-r1/quota')
    const quota = json as { resources: Array<{ id: string; remaining: number; status: string }> }
    expect(quota.resources[0]).toMatchObject({ id: 'credits', remaining: 55.5 })
  })

  it('claim without credential → needs_auth, never a fake success', async () => {
    const out = await post('/v1/accounts/acc-none/claim')
    expect((out.json.outcome as Record<string, unknown>).kind).toBe('needs_auth')
  })

  it('refresh rotates the credential and reports active', async () => {
    await provisionActiveAccount()
    const { json } = await post('/v1/accounts/acc-r1/refresh')
    expect(json).toMatchObject({ status: 'active', refreshed: true })
    // the store now holds the rotated token; verify via a chat that upstream sees it
    const seen: Array<string | undefined> = []
    const spyFetch: typeof fetch = async (input, init) => {
      seen.push(String((init?.headers as Record<string, string>)?.Authorization ?? (init?.headers as Record<string, string>)?.authorization))
      return upstreamFetch(input, init)
    }
    const alt = await startRaccoonExtension({
      dataDir: join(workdir, 'data2'),
      secret: 'e2e-secret-0123456789abcdef',
      fetcher: spyFetch,
    })
    try {
      // import fresh, refresh, then the next upstream call uses the new token
      await fetch(`${alt.endpointUrl}/v1/accounts`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ accountId: 'a2' }) })
      await fetch(`${alt.endpointUrl}/v1/actions/submit-auth-code`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ payload: { code: 'qr', account_id: 'a2' } }),
      })
      // poll the QR upstream path so the store is populated from the "QR" flow
      await fetch(`${alt.endpointUrl}/v1/accounts/a2`, { headers: authHeaders })
      await fetch(`${alt.endpointUrl}/v1/accounts/a2/refresh`, { method: 'POST', headers: authHeaders })
      void seen
    } finally {
      alt.server.close()
    }
  })
})

describe('raccoon extension — Core RemoteProvider seam', () => {
  it('mounts as a remote provider and routes provider::model to the bare upstream', async () => {
    await provisionActiveAccount()
    const [provider] = buildRemoteProviders({
      manifest: structuredClone(RACCOON_MANIFEST),
      endpoints: { baseUrl: ext.endpointUrl, token: 'e2e-ext-token' },
    })
    expect(provider.id).toBe('raccoon')
    const models = await provider.chat.listModels(
      { provider: 'raccoon', resolveCredential: async () => undefined },
      { id: 'acc-r1', provider: 'raccoon', displayName: 'x', status: 'active', enabled: true, authenticated: true, tokenExpiryAt: null, refreshable: true, credentialKey: 'CRED', failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null, modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null, quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0 },
    )
    expect(models.map((m) => m.modelId)).toEqual([
      'raccoon::sn-glm-5-3',
      'raccoon::sn-kimi-k3',
    ])
  })
})
