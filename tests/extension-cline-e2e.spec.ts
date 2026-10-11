/**
 * Cline Extension E2E — the full protocol surface over real HTTP:
 * manifest/health → device-code login (pending → authorized → registered) →
 * action-channel import → models (dual-endpoint catalog) → chat JSON+SSE with
 * tools → quota → claim (unsupported) → refresh. All upstream traffic hits a
 * stub fetcher.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startClineExtension, CLINE_MANIFEST } from '../src/extensions/cline/main.js'
import { buildRemoteProviders } from '../src/protocol/extension/remote-provider.js'
import { validateManifest } from '../src/protocol/extension/validate-manifest.js'
import {
  CLINE_BALANCE_PATH_PREFIX, CLINE_CHAT_PATH, CLINE_DEVICE_AUTHORIZATION_PATH, CLINE_DEVICE_AUTHENTICATE_PATH,
  CLINE_ME_PATH, CLINE_MODELS_PATH, CLINE_RECOMMENDED_MODELS_PATH, CLINE_REFRESH_PATH, CLINE_REGISTER_PATH,
} from '../src/providers/cline/product.js'

let upstreamBehavior = {
  devicePoll: 'authorized' as 'pending' | 'authorized' | 'denied',
  chatStatus: 200,
}

const authHeaders = { 'content-type': 'application/json', authorization: 'Bearer e2e-ext-token' }

const upstreamFetch: typeof fetch = async (input, init) => {
  const path = String(input).replace(/^https:\/\/[^/]+/, '')
  if (path.includes(CLINE_DEVICE_AUTHORIZATION_PATH)) {
    return new Response(JSON.stringify({
      device_code: 'dev-code-1', user_code: 'ABCD-EFGH',
      verification_uri: 'https://cline.bot/device', verification_uri_complete: 'https://cline.bot/device?c=ABCD-EFGH',
      expires_in: 300, interval: 5,
    }), { status: 200 })
  }
  if (path.includes(CLINE_DEVICE_AUTHENTICATE_PATH)) {
    if (upstreamBehavior.devicePoll === 'pending') {
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 })
    }
    if (upstreamBehavior.devicePoll === 'denied') {
      return new Response(JSON.stringify({ error: 'access_denied' }), { status: 400 })
    }
    return new Response(JSON.stringify({ access_token: 'workos-at', refresh_token: 'workos-rt' }), { status: 200 })
  }
  if (path.includes(CLINE_REGISTER_PATH)) {
    return new Response(JSON.stringify({
      success: true,
      data: { accessToken: 'cl-at', refreshToken: 'cl-rt', expiresAt: '2100-01-01T00:00:00Z', email: 'x@y.z', userId: 'u-9' },
    }), { status: 200 })
  }
  if (path.includes(CLINE_REFRESH_PATH)) {
    return new Response(JSON.stringify({
      success: true,
      data: { accessToken: 'cl-at-2', refreshToken: 'cl-rt-2', expiresAt: '2101-01-01T00:00:00Z', email: 'x@y.z', userId: 'u-9' },
    }), { status: 200 })
  }
  if (path.includes(CLINE_RECOMMENDED_MODELS_PATH)) {
    return new Response(JSON.stringify({ data: { free: ['cline-free/deepseek-v4.1-flash'] } }), { status: 200 })
  }
  if (path.includes(CLINE_MODELS_PATH)) {
    return new Response(JSON.stringify({ data: { models: [{ id: 'anthropic/claude-sonnet-4.5' }, { id: 'cline-free/gemini-3.8-flash' }] } }), { status: 200 })
  }
  if (path.includes(CLINE_CHAT_PATH)) {
    if (upstreamBehavior.chatStatus !== 200) return new Response('upstream down', { status: upstreamBehavior.chatStatus })
    const sse = [
      'data: {"choices":[{"delta":{"content":"he"}}]}',
      'data: {"choices":[{"delta":{"content":"llo"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2}}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  if (path.includes(CLINE_BALANCE_PATH_PREFIX) || path.includes(CLINE_ME_PATH)) {
    return new Response(JSON.stringify({ success: true, data: { userId: 'u-9', balance: 500000 } }), { status: 200 })
  }
  return new Response('not found', { status: 404 })
}

const workdir = mkdtempSync(join(tmpdir(), 'gw-cline-e2e-'))
let ext: Awaited<ReturnType<typeof startClineExtension>>

beforeAll(async () => {
  ext = await startClineExtension({
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

/** Device-code login: create (pending) → read detail until active. */
async function provisionActiveAccount(): Promise<string> {
  const existing = await get('/v1/accounts/acc-c1')
  if (existing.status === 200 && (existing.json.account as Record<string, unknown>).status === 'active') return 'acc-c1'
  const created = await post('/v1/accounts', { accountId: 'acc-c1' })
  if (created.status !== 201) throw new Error(`account creation returned ${created.status}`)
  // the device flow completes on the first poll (stub returns authorized)
  const { json } = await get('/v1/accounts/acc-c1')
  const account = json.account as Record<string, unknown>
  expect(account).toMatchObject({ accountId: 'acc-c1', status: 'active' })
  return 'acc-c1'
}

describe('cline extension — manifest and health', () => {
  it('serves a valid manifest and healthy status', async () => {
    const validation = validateManifest(CLINE_MANIFEST)
    expect(validation.ok).toBe(true)
    const manifest = await fetch(`${ext.endpointUrl}/manifest`).then((r) => r.json())
    expect(manifest).toMatchObject({ extension: { id: 'cline' } })
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
  })
})

describe('cline extension — device-code login lifecycle', () => {
  it('completes the device flow and never exposes tokens in projections', async () => {
    await provisionActiveAccount()
    const { json } = await get('/v1/accounts/acc-c1')
    const body = JSON.stringify(json)
    expect(body).not.toContain('workos-at')
    expect(body).not.toContain('cl-at')
    expect(body).not.toContain('access_token')
  })

  it('a denied device login reports auth_failed without storing credentials', async () => {
    upstreamBehavior.devicePoll = 'denied'
    try {
      await post('/v1/accounts', { accountId: 'acc-denied' })
      const { json } = await get('/v1/accounts/acc-denied')
      expect((json.account as Record<string, unknown>).status).toBe('auth_failed')
      // no store record (denied login) → chat fails with unknown account
      const chat = await post('/v1/chat', { accountId: 'acc-denied', model: 'm', messages: [], stream: false })
      expect(chat.status).toBe(404)
      expect((chat.json.error as Record<string, unknown>).kind).toBe('TERMINAL')
    } finally {
      upstreamBehavior.devicePoll = 'authorized'
    }
  })

  it('importCredential via the action channel accepts a credential blob', async () => {
    const out = await post('/v1/actions/submit-auth-code', {
      payload: { access_token: 'imported-tok', refresh_token: 'imported-rt', account_id: 'acc-imp' },
    })
    expect((out.json.result as Record<string, unknown>).accepted).toBe(true)
    const { json } = await get('/v1/accounts/acc-imp')
    expect((json.account as Record<string, unknown>).status).toBe('active')
  })
})

describe('cline extension — models, chat, quota, claim', () => {
  it('merges the dual-endpoint catalog with free-model marking', async () => {
    await provisionActiveAccount()
    const { json } = await get('/v1/models')
    const models = json.models as Array<{ id: string; metadata?: { free?: boolean } }>
    const ids = models.map((m) => m.id)
    expect(ids).toContain('anthropic/claude-sonnet-4.5')
    const free = models.find((m) => m.id === 'cline-free/deepseek-v4.1-flash')
    expect(free?.metadata?.free).toBe(true)
  })

  it('aggregates a non-stream chat and strips the namespace prefix upstream', async () => {
    await provisionActiveAccount()
    const { status, json } = await post('/v1/chat', {
      accountId: 'acc-c1',
      model: 'cline::anthropic/claude-sonnet-4.5', // namespaced in; bare upstream
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
      body: JSON.stringify({ accountId: 'acc-c1', model: 'anthropic/claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('event: chunk')
    expect(text).toContain('"finishReason":"stop"')
  })

  it('maps upstream chat failures to structured errors', async () => {
    await provisionActiveAccount()
    upstreamBehavior.chatStatus = 503
    try {
      const { status, json } = await post('/v1/chat', { accountId: 'acc-c1', model: 'm', messages: [], stream: false })
      expect(status).toBe(502)
      expect((json.error as Record<string, unknown>).kind).toBe('UPSTREAM_5XX')
    } finally {
      upstreamBehavior.chatStatus = 200
    }
  })

  it('projects the upstream balance as quota resources', async () => {
    await provisionActiveAccount()
    const { json } = await get('/v1/accounts/acc-c1/quota')
    const quota = json as { resources: Array<{ id: string; remaining: number }> }
    expect(quota.resources[0]).toMatchObject({ id: 'credits', remaining: 500000 })
  })

  it('claim is honestly unsupported (Cline has no check-in)', async () => {
    const out = await post('/v1/accounts/acc-c1/claim')
    expect((out.json.outcome as Record<string, unknown>).kind).toBe('unsupported')
  })

  it('refresh rotates the credential', async () => {
    await provisionActiveAccount()
    const { json } = await post('/v1/accounts/acc-c1/refresh')
    expect(json).toMatchObject({ status: 'active', refreshed: true })
  })
})

describe('cline extension — Core RemoteProvider seam', () => {
  it('mounts as a remote provider with namespaced model ids', async () => {
    await provisionActiveAccount()
    const [provider] = buildRemoteProviders({
      manifest: structuredClone(CLINE_MANIFEST),
      endpoints: { baseUrl: ext.endpointUrl, token: 'e2e-ext-token' },
    })
    expect(provider.id).toBe('cline')
    const models = await provider.chat.listModels(
      { provider: 'cline', resolveCredential: async () => undefined },
      { id: 'acc-c1', provider: 'cline', displayName: 'x', status: 'active', enabled: true, authenticated: true, tokenExpiryAt: null, refreshable: true, credentialKey: 'CRED', failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null, modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null, quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0 },
    )
    expect(models.every((m) => m.modelId.startsWith('cline::'))).toBe(true)
    expect(models.map((m) => m.modelId)).toContain('cline::anthropic/claude-sonnet-4.5')
  })
})
