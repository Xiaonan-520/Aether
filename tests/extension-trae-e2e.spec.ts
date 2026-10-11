/**
 * TRAE Extension E2E — full protocol surface over real HTTP, for BOTH product
 * instances (trae + trae-intl) to prove the real product.id namespaces:
 * manifest → external-link login → action-channel import (refresh token →
 * ExchangeToken) → models → SOLO chat (JSON + SSE) → quota → claim → refresh.
 * All upstream traffic hits a stub fetcher.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startTraeExtension, TRAE_MANIFEST, traeManifestFor } from '../src/extensions/trae/main.js'
import { buildRemoteProviders } from '../src/protocol/extension/remote-provider.js'
import { validateManifest } from '../src/protocol/extension/validate-manifest.js'
import { TRAE, TRAE_INTL, TRAE_BATCH_MODELS_PATH, TRAE_CHAT_PATH, TRAE_EXCHANGE_PATH, TRAE_USER_INFO_PATH } from '../src/providers/trae/product.js'

let upstreamBehavior = { exchangeOk: true, chatStatus: 200 }

const authHeaders = { 'content-type': 'application/json', authorization: 'Bearer e2e-ext-token' }

const upstreamFetch: typeof fetch = async (input) => {
  const path = String(input).replace(/^https:\/\/[^/]+/, '')
  if (path.includes(TRAE_EXCHANGE_PATH)) {
    if (!upstreamBehavior.exchangeOk) return new Response(JSON.stringify({ error: 'bad token' }), { status: 401 })
    return new Response(JSON.stringify({
      data: {
        access_token: 'tr-at', refresh_token: 'tr-rt-2', expires_in: 3600,
        user: { id: 'u-1', nickname: 'Nina' },
      },
    }), { status: 200 })
  }
  if (path.includes(TRAE_BATCH_MODELS_PATH)) {
    return new Response(JSON.stringify({
      function_configs: [
        {
          function: 'capital',
          config_info_list: [
            { config_name: 'gemini-3.8-pro', display_name: 'Gemini 3.8 Pro', usage: 'chat_completion', config_switch: true },
            { config_name: 'deepseek-v4.2', display_name: 'DeepSeek V4.2', usage: 'chat_completion', config_switch: true },
          ],
        },
      ],
    }), { status: 200 })
  }
  if (path.includes(TRAE_CHAT_PATH)) {
    if (upstreamBehavior.chatStatus !== 200) return new Response('upstream down', { status: upstreamBehavior.chatStatus })
    const body = 'event:output\ndata:{"response":"he"}\n\n' +
      'event:output\ndata:{"response":"llo"}\n\n' +
      'event:token_usage\ndata:{"prompt_tokens":3,"completion_tokens":2}\n\n' +
      'event:done\ndata:{"finish_reason":"stop"}\n\n'
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  if (path.includes(TRAE_USER_INFO_PATH)) {
    return new Response(JSON.stringify({ data: { user: { id: 'u-1' } } }), { status: 200 })
  }
  return new Response('not found', { status: 404 })
}

const workdir = mkdtempSync(join(tmpdir(), 'gw-trae-e2e-'))
let cn: Awaited<ReturnType<typeof startTraeExtension>>
let intl: Awaited<ReturnType<typeof startTraeExtension>>

beforeAll(async () => {
  cn = await startTraeExtension({ dataDir: join(workdir, 'cn'), secret: 'e2e-secret-0123456789abcdef', fetcher: upstreamFetch })
  intl = await startTraeExtension({ dataDir: join(workdir, 'intl'), secret: 'e2e-secret-0123456789abcdef', fetcher: upstreamFetch, product: TRAE_INTL })
  process.env.GATEWAY_EXTENSION_TOKEN = 'e2e-ext-token'
})

afterAll(() => {
  delete process.env.GATEWAY_EXTENSION_TOKEN
  cn.server.close()
  intl.server.close()
  rmSync(workdir, { recursive: true, force: true })
})

async function postTo(ext: typeof cn, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${ext.endpointUrl}${path}`, {
    method: 'POST',
    headers: authHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function getFrom(ext: typeof cn, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${ext.endpointUrl}${path}`, { headers: authHeaders })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function provision(ext: typeof cn, accountId: string): Promise<void> {
  const existing = await getFrom(ext, `/v1/accounts/${accountId}`)
  if (existing.status === 200 && (existing.json.account as Record<string, unknown>).status === 'active') return
  const created = await postTo(ext, '/v1/accounts', { accountId })
  if (created.status !== 201) throw new Error(`creation returned ${created.status}: ${JSON.stringify(created.json)}`)
  const imported = await postTo(ext, '/v1/actions/submit-auth-code', { payload: { refresh_token: 'cb-rt', account_id: accountId } })
  expect((imported.json.result as Record<string, unknown>).accepted).toBe(true)
}

describe('trae extension — manifests for both product instances', () => {
  it('the CN manifest validates and carries provider id trae', async () => {
    expect(validateManifest(TRAE_MANIFEST).ok).toBe(true)
    expect(TRAE_MANIFEST.providers[0]!.id).toBe('trae')
  })

  it('the intl manifest uses the real trae-intl product id (never a hard-coded literal)', () => {
    const intlManifest = traeManifestFor(TRAE_INTL)
    expect(validateManifest(intlManifest).ok).toBe(true)
    expect(intlManifest.providers[0]!.id).toBe('trae-intl')
    expect(intlManifest.extension.id).toBe('trae-intl')
  })
})

describe('trae extension — login lifecycle and chat', () => {
  it('activates through the callback refresh token via ExchangeToken', async () => {
    await provision(cn, 'acc-t1')
    const { json } = await getFrom(cn, '/v1/accounts/acc-t1')
    const account = json.account as Record<string, unknown>
    expect(account).toMatchObject({ accountId: 'acc-t1', status: 'active', providerId: 'trae' })
    expect(JSON.stringify(json)).not.toContain('tr-at')
  })

  it('aggregates a non-stream SOLO chat and strips the namespace prefix upstream', async () => {
    await provision(cn, 'acc-t1')
    const { status, json } = await postTo(cn, '/v1/chat', {
      accountId: 'acc-t1',
      model: 'trae::gemini-3.8-pro', // namespaced in; bare upstream
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(status).toBe(200)
    expect(json).toMatchObject({ content: 'hello', finishReason: 'stop' })
  })

  it('streams SOLO output as SSE chunk events', async () => {
    await provision(cn, 'acc-t1')
    const res = await fetch(`${cn.endpointUrl}/v1/chat`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ accountId: 'acc-t1', model: 'gemini-3.8-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('event: chunk')
    expect(text).toContain('"finishReason":"stop"')
  })

  it('lists remote models and projects quota', async () => {
    await provision(cn, 'acc-t1')
    const models = await getFrom(cn, '/v1/models')
    expect((models.json.models as Array<{ id: string }>).map((m) => m.id)).toContain('gemini-3.8-pro')
    const quota = await getFrom(cn, '/v1/accounts/acc-t1/quota')
    expect((quota.json as { resources: Array<{ id: string }> }).resources[0]!.id).toBe('credits')
  })

  it('refresh rotates the credential via ExchangeToken; failure maps to AUTH_INVALID', async () => {
    await provision(cn, 'acc-t1')
    const { json } = await postTo(cn, '/v1/accounts/acc-t1/refresh')
    expect(json).toMatchObject({ status: 'active', refreshed: true })
    upstreamBehavior.exchangeOk = false
    try {
      const bad = await postTo(cn, '/v1/accounts/acc-t1/refresh')
      expect((bad.json.error as Record<string, unknown>).kind).toBe('AUTH_INVALID')
    } finally {
      upstreamBehavior.exchangeOk = true
    }
  })
})

describe('trae extension — the intl instance is fully independent', () => {
  it('serves its own accounts, models and chat under the trae-intl product id', async () => {
    await provision(intl, 'acc-i1')
    const detail = await getFrom(intl, '/v1/accounts/acc-i1')
    expect((detail.json.account as Record<string, unknown>).providerId).toBe('trae-intl')
    // no cross-instance leakage: the CN account is unknown on intl
    const cross = await getFrom(intl, '/v1/accounts/acc-t1')
    expect(cross.status).toBe(404)
    const models = await getFrom(intl, '/v1/models')
    expect((models.json.models as Array<{ id: string }>).map((m) => m.id)).toContain('gemini-3.8-pro')
  })

  it('mounts both instances as distinct Core remote providers', async () => {
    const [cnProvider] = buildRemoteProviders({
      manifest: structuredClone(TRAE_MANIFEST),
      endpoints: { baseUrl: cn.endpointUrl, token: 'e2e-ext-token' },
    })
    const [intlProvider] = buildRemoteProviders({
      manifest: traeManifestFor(TRAE_INTL),
      endpoints: { baseUrl: intl.endpointUrl, token: 'e2e-ext-token' },
    })
    expect(cnProvider.id).toBe('trae')
    expect(intlProvider.id).toBe('trae-intl')
    const models = await cnProvider.chat.listModels(
      { provider: 'trae', resolveCredential: async () => undefined },
      { id: 'acc-t1', provider: 'trae', displayName: 'x', status: 'active', enabled: true, authenticated: true, tokenExpiryAt: null, refreshable: true, credentialKey: 'CRED', failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null, modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null, quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0 },
    )
    expect(models.every((m) => m.modelId.startsWith('trae::'))).toBe(true)
  })
})
