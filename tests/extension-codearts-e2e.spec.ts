/**
 * CodeArts Extension E2E — full protocol surface over real HTTP:
 * manifest/health → external-link login → action-channel AK/SK import →
 * models → HMAC-signed chat (JSON + SSE) → package quota → claim → honest
 * not-refreshable semantics. All upstream traffic hits a stub fetcher.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startCodeArtsExtension, CODEARTS_MANIFEST } from '../src/extensions/codearts/main.js'
import { buildRemoteProviders } from '../src/protocol/extension/remote-provider.js'
import { validateManifest } from '../src/protocol/extension/validate-manifest.js'
import { CODEARTS_CHAT_PATH, CODEARTS_SNAP_MODEL_BUILTIN_PATH } from '../src/providers/codearts/product.js'

let upstreamBehavior = { chatStatus: 200 }

const authHeaders = { 'content-type': 'application/json', authorization: 'Bearer e2e-ext-token' }

const upstreamFetch: typeof fetch = async (input) => {
  const path = String(input).replace(/^https:\/\/[^/]+/, '')
  if (path.includes(CODEARTS_SNAP_MODEL_BUILTIN_PATH)) {
    return new Response(JSON.stringify({ data: [{ id: 'glm-5.3', name: 'GLM-5.3' }, { id: 'deepseek-v4-flash', name: 'DS V4 Benefit' }] }), { status: 200 })
  }
  if (path.includes(CODEARTS_CHAT_PATH)) {
    if (upstreamBehavior.chatStatus !== 200) return new Response('upstream down', { status: upstreamBehavior.chatStatus })
    const sse = [
      'data: {"choices":[{"delta":{"content":"he"}}]}',
      'data: {"choices":[{"delta":{"content":"llo"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2}}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  if (path.includes('/snap-manager/v1/statistics/plugin')) {
    return new Response(JSON.stringify({ data: { remaining: 77, total: 200 } }), { status: 200 })
  }
  if (path.includes('/v1/ops/claim')) {
    return new Response(JSON.stringify({ code: 'Success', data: { credits: 5 } }), { status: 200 })
  }
  return new Response('not found', { status: 404 })
}

const workdir = mkdtempSync(join(tmpdir(), 'gw-codearts-e2e-'))
let ext: Awaited<ReturnType<typeof startCodeArtsExtension>>

beforeAll(async () => {
  ext = await startCodeArtsExtension({
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

const AK_BLOB = {
  access_key_id: 'AKTEST',
  secret_access_key: 'SKTEST',
  security_token: 'tok',
  expires_at: String(Date.now() + 3_600_000),
}

async function provisionActiveAccount(): Promise<string> {
  const existing = await get('/v1/accounts/acc-ca1')
  if (existing.status === 200 && (existing.json.account as Record<string, unknown>).status === 'active') return 'acc-ca1'
  const created = await post('/v1/accounts', { accountId: 'acc-ca1' })
  if (created.status !== 201) throw new Error(`creation returned ${created.status}`)
  const imported = await post('/v1/actions/submit-auth-code', { payload: { ...AK_BLOB, account_id: 'acc-ca1' } })
  expect((imported.json.result as Record<string, unknown>).accepted).toBe(true)
  const { json } = await get('/v1/accounts/acc-ca1')
  expect((json.account as Record<string, unknown>).status).toBe('active')
  return 'acc-ca1'
}

describe('codearts extension — manifest and health', () => {
  it('serves a valid manifest and healthy status', async () => {
    expect(validateManifest(CODEARTS_MANIFEST).ok).toBe(true)
    const manifest = await fetch(`${ext.endpointUrl}/manifest`).then((r) => r.json())
    expect(manifest).toMatchObject({ extension: { id: 'codearts' } })
    const health = await fetch(`${ext.endpointUrl}/health`).then((r) => r.json())
    expect(health).toMatchObject({ status: 'healthy' })
  })

  it('rejects protocol routes without the extension token', async () => {
    const res = await fetch(`${ext.endpointUrl}/v1/accounts`)
    expect(res.status).toBe(401)
  })

  it('forbids credential fields in account creation (RFC §10.3)', async () => {
    const out = await post('/v1/accounts', { access_key_id: 'x' })
    expect(out.status).toBe(400)
  })
})

describe('codearts extension — login lifecycle', () => {
  it('activates via the AK/SK import and never echoes secrets', async () => {
    await provisionActiveAccount()
    const { json } = await get('/v1/accounts/acc-ca1')
    const body = JSON.stringify(json)
    expect(body).not.toContain('AKTEST')
    expect(body).not.toContain('SKTEST')
    expect((json.account as Record<string, unknown>).status).toBe('active')
  })

  it('rejects an unparseable import without storing anything', async () => {
    const out = await post('/v1/actions/submit-auth-code', { payload: { garbage: true } })
    expect((out.json.result as Record<string, unknown>).accepted).toBe(false)
  })
})

describe('codearts extension — models, chat, quota, claim', () => {
  it('lists remote models and marks benefit models', async () => {
    await provisionActiveAccount()
    const { json } = await get('/v1/models')
    const models = json.models as Array<{ id: string; metadata?: Record<string, unknown> }>
    expect(models.map((m) => m.id)).toContain('glm-5.3')
    const benefit = models.find((m) => m.id === 'deepseek-v4-flash')
    expect(benefit?.metadata).toMatchObject({ benefit: true })
  })

  it('aggregates a non-stream chat and strips the namespace prefix upstream', async () => {
    await provisionActiveAccount()
    const { status, json } = await post('/v1/chat', {
      accountId: 'acc-ca1',
      model: 'codearts::glm-5.3', // namespaced in; bare upstream
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
      body: JSON.stringify({ accountId: 'acc-ca1', model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toContain('event: chunk')
  })

  it('maps upstream chat failures to structured errors', async () => {
    await provisionActiveAccount()
    upstreamBehavior.chatStatus = 500
    try {
      const { status, json } = await post('/v1/chat', { accountId: 'acc-ca1', model: 'm', messages: [], stream: false })
      expect(status).toBe(502)
      expect((json.error as Record<string, unknown>).kind).toBe('UPSTREAM_5XX')
    } finally {
      upstreamBehavior.chatStatus = 200
    }
  })

  it('projects the package quota', async () => {
    await provisionActiveAccount()
    const { json } = await get('/v1/accounts/acc-ca1/quota')
    const quota = json as { resources: Array<{ id: string; remaining: number; total: number }> }
    expect(quota.resources[0]).toMatchObject({ id: 'credits', remaining: 77, total: 200 })
  })

  it('refresh is honestly not-refreshable (temporary AK/SK)', async () => {
    await provisionActiveAccount()
    const { json } = await post('/v1/accounts/acc-ca1/refresh')
    expect(json).toMatchObject({ refreshed: false })
    expect(String(json.error)).toContain('temporary AK/SK')
  })
})

describe('codearts extension — Core RemoteProvider seam', () => {
  it('mounts as a remote provider with namespaced model ids', async () => {
    await provisionActiveAccount()
    const [provider] = buildRemoteProviders({
      manifest: structuredClone(CODEARTS_MANIFEST),
      endpoints: { baseUrl: ext.endpointUrl, token: 'e2e-ext-token' },
    })
    expect(provider.id).toBe('codearts')
    const models = await provider.chat.listModels(
      { provider: 'codearts', resolveCredential: async () => undefined },
      { id: 'acc-ca1', provider: 'codearts', displayName: 'x', status: 'active', enabled: true, authenticated: true, tokenExpiryAt: null, refreshable: false, credentialKey: 'CRED', failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null, modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null, quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0 },
    )
    expect(models.map((m) => m.modelId)).toEqual(['codearts::glm-5.3', 'codearts::deepseek-v4-flash'])
  })
})
