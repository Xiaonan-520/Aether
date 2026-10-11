/**
 * Qoder contracts (international + CN).
 *
 * The encrypted-inference path is exercised against the **real WASM binary**
 * (not a stub) when the operator has provided one, because the whole point of
 * that layer is producing a valid `COSY` signature and encrypted body. The
 * binary is not part of the repo; absent-binary behavior is asserted too.
 * Device identity is asserted to be account-scoped and persisted.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  QODER,
  QODER_CN,
  ALL_QODER_PRODUCTS,
  QODER_DEVICE_SELECT_PATH,
  QODER_POLL_PATH,
  QODER_REFRESH_PATH,
  QODER_USAGE_PATH,
  qoderProductById,
} from '../src/providers/qoder/product.js'
import {
  buildQoderAuthUrl,
  buildQoderCredential,
  buildQoderPollUrl,
  createQoderNonce,
  createQoderPkce,
  isQoderRefreshable,
  newQoderMachineId,
  parseQoderCampaigns,
  parseQoderModels,
  parseQoderTokenPayload,
  qoderHeaders,
  qoderRefreshBody,
} from '../src/providers/qoder/protocol.js'
import { QoderEncryptedInfer } from '../src/providers/qoder/wasm.js'
import { createQoderProvider } from '../src/providers/qoder/provider.js'
import type { Account } from '../src/core/types.js'
import type { ProviderCtx } from '../src/core/registry/provider.js'

function account(id = 'qoder-a1'): Account {
  return {
    id, provider: 'qoder', displayName: id, status: 'active', enabled: true, authenticated: true,
    tokenExpiryAt: null, refreshable: true, credentialKey: `CRED_${id}`, failureCount: 0,
    lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null, modelRateLimits: {},
    quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null, quotaManualRequired: false,
    providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
}

const CRED = {
  access_token: 'acc',
  security_oauth_token: 'acc',
  refresh_token: 'ref',
  machine_id: '11111111-1111-4111-8111-111111111111',
  uid: 'user-1',
  expires_at: String(Date.now() + 3_600_000),
}

function ctx(credential: unknown = CRED): ProviderCtx {
  return { provider: 'qoder', resolveCredential: async () => ({ ref: 'r', expiresAt: null, refreshable: true, credential }) }
}

interface Route { match: string; json?: unknown; text?: string; status?: number }
function makeFetcher(routes: Route[], onCall?: (url: string, init?: RequestInit) => void) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    onCall?.(url, init)
    for (const r of routes) {
      if (!url.includes(r.match)) continue
      const status = r.status ?? 200
      if (r.text !== undefined) return new Response(r.text, { status, headers: { 'content-type': 'text/event-stream' } })
      return new Response(JSON.stringify(r.json ?? {}), { status, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

describe('qoder wasm (real binary)', () => {
  // The binary is not distributed with the repo; these run only when an
  // operator (or dev checkout) has provided it.
  const hasWasm = existsSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/providers/qoder/qoder-auth-wasm.wasm'))
  it.skipIf(!hasWasm)('builds an encrypted request with the COSY auth header', async () => {
    const infer = await QoderEncryptedInfer.create({
      user: { uid: 'u1', securityOauthToken: 'tok' },
      machineId: CRED.machine_id,
      metadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
      host: QODER.inferHost,
      clientVersion: QODER.clientVersion,
    })
    const req = infer.prepareInfer({ modelKey: 'qfmodel', userText: 'hi' } as never)
    expect(req.url).toContain('/algo/api/v2/service/pro/sse/agent_chat_generation')
    expect(req.url).toContain('Encode=1')
    expect(req.headers.Authorization).toMatch(/^Bearer COSY\./)
    expect(req.body.length).toBeGreaterThan(0)
    expect(Object.keys(req.headers).length).toBeGreaterThan(5)
  })

  it.skipIf(!hasWasm)('produces a different signature for a different machine id (account isolation)', async () => {
    const make = async (machineId: string) => {
      const infer = await QoderEncryptedInfer.create({
        user: { uid: 'u1', securityOauthToken: 'tok' },
        machineId,
        metadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
        host: QODER.inferHost,
        clientVersion: QODER.clientVersion,
      })
      return infer.prepareInfer({ modelKey: 'qfmodel', userText: 'hi' } as never).headers.Authorization
    }
    const a = await make('11111111-1111-4111-8111-111111111111')
    const b = await make('22222222-2222-4222-8222-222222222222')
    expect(a).not.toBe(b)
  })

  it('fails with a clear NEEDS_MANUAL error when the WASM is absent', async () => {
    // only meaningful when the binary is genuinely missing (fresh clone)
    if (hasWasm) return
    const { __testing } = await import('../src/providers/qoder/wasm.js')
    __testing.resetGlue()
    await expect(QoderEncryptedInfer.create({
      user: { uid: 'u1', securityOauthToken: 'tok' },
      machineId: CRED.machine_id,
      metadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
      host: QODER.inferHost,
    })).rejects.toMatchObject({
      kind: 'NEEDS_MANUAL',
      message: expect.stringContaining('not distributed'),
    })
  })
})

describe('qoder PKCE + host separation (regression)', () => {
  it('creates a PKCE pair with a base64url challenge and no padding', () => {
    const pkce = createQoderPkce()
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pkce.verifier.length).toBeLessThanOrEqual(128)
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9._~-]+$/)
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pkce.challenge).not.toContain('=')
    expect(createQoderPkce().verifier).not.toBe(pkce.verifier)
    // challenge is base64url(sha256(verifier))
    const expected = createHash('sha256').update(pkce.verifier).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(pkce.challenge).toBe(expected)
  })

  it('builds the auth URL on authBase with challenge_method=S256, nonce, machine_id, client_id', () => {
    const url = buildQoderAuthUrl({ machineId: 'm1', nonce: 'n1', pkce: { verifier: 'v', challenge: 'c' } }, QODER)
    expect(new URL(url).host).toBe('qoder.com')
    expect(url).toContain('challenge=c')
    expect(url).toContain('challenge_method=S256')
    expect(url).toContain('nonce=n1')
    expect(url).toContain('machine_id=m1')
    expect(url).toContain('client_id=')
  })

  it('builds the poll URL on openApiBase carrying nonce + verifier (was 400 DeviceTokenNonceRequired)', () => {
    // Regression: the poll endpoint rejects a request without `nonce`
    // (HTTP 400 DeviceTokenNonceRequired), verified live upstream.
    const url = buildQoderPollUrl({ nonce: 'n1', pkce: { verifier: 'v1', challenge: 'c' } }, QODER)
    expect(new URL(url).host).toBe('openapi.qoder.sh')
    expect(url).toContain('nonce=n1')
    expect(url).toContain('verifier=v1')
    expect(url).toContain('challenge_method=S256')
    expect(url).not.toContain('machine_id=')
  })

  it('separates authBase from openApiBase for both products', () => {
    expect(QODER.authBase).not.toBe(QODER.openApiBase)
    expect(QODER_CN.authBase).not.toBe(QODER_CN.openApiBase)
    expect(new URL(buildQoderPollUrl({ nonce: 'n', pkce: { verifier: 'v', challenge: 'c' } }, QODER_CN)).host)
      .toBe('openapi.qoder.com.cn')
    expect(new URL(buildQoderAuthUrl({ machineId: 'm', nonce: 'n', pkce: { verifier: 'v', challenge: 'c' } }, QODER_CN)).host)
      .toBe('qoder.cn')
  })

  it('refreshes and reads userinfo on openApiBase', async () => {
    const calls: string[] = []
    const fetcher = makeFetcher(
      [
        { match: QODER_REFRESH_PATH, json: { data: { access_token: 'a2', refresh_token: 'r2' } } },
        { match: '/api/v1/userinfo', json: { data: {} } },
      ],
      (u) => calls.push(u),
    )
    const p = createQoderProvider({ fetcher })
    await p.ops.refreshAccount!(ctx(), account())
    await p.ops.healthCheck!(ctx(), account())
    expect(calls.every((u) => u.includes('openapi.qoder.sh'))).toBe(true)
  })
})

describe('qoder protocol', () => {
  it('exposes INTL and CN as separate products with distinct hosts', () => {
    expect(ALL_QODER_PRODUCTS.map((p) => p.id)).toEqual(['qoder', 'qoder-cn'])
    expect(QODER.authBase).not.toBe(QODER_CN.authBase)
    expect(qoderProductById('qoder-cn')).toBe(QODER_CN)
  })

  it('sends Cosy-ClientType 10 (the value that unlocks the sash endpoints)', () => {
    expect(String(QODER.clientType)).toBe('10')
    expect(qoderHeaders(CRED as never, QODER)['Cosy-ClientType']).toBe('10')
    expect(qoderHeaders(CRED as never, QODER).Authorization).toBe('Bearer acc')
  })

  it('generates a unique machine id and keeps it across credential rebuilds', () => {
    const a = newQoderMachineId()
    const b = newQoderMachineId()
    expect(a).not.toBe(b)
    const rebuilt = buildQoderCredential(
      { accessToken: 'a2', refreshToken: 'r2' },
      { machine_id: a, uid: 'u' },
    )
    expect(rebuilt.machine_id).toBe(a)
    expect(rebuilt.security_oauth_token).toBe('a2')
  })

  it('sends machine_id in the refresh body', () => {
    expect(qoderRefreshBody(CRED as never)).toEqual({ refresh_token: 'ref', machine_id: CRED.machine_id })
  })

  it('parses tokens, models and campaigns', () => {
    expect(parseQoderTokenPayload({ data: { access_token: 'a', refresh_token: 'r', user_id: 'u' } }))
      .toMatchObject({ accessToken: 'a', refreshToken: 'r', uid: 'u' })
    expect(parseQoderTokenPayload({ access_token: 'a' })).toMatchObject({ accessToken: 'a' })
    expect(parseQoderModels({ models: [{ key: 'qfmodel', name: 'Qwen3.8-Flash' }] })).toEqual([{ id: 'qfmodel', name: 'Qwen3.8-Flash' }])
    expect(parseQoderCampaigns({ data: { campaigns: [{ campaignId: 'c1', status: 'CLAIMABLE' }, { id: 'c2' }] } }))
      .toEqual([{ campaignId: 'c1', claimable: true }, { campaignId: 'c2', claimable: false }])
  })

  it('reports refreshability', () => {
    expect(isQoderRefreshable(CRED as never)).toBe(true)
    expect(isQoderRefreshable({ ...CRED, refresh_token: '' } as never)).toBe(false)
  })
})

describe('qoder adapter', () => {
  it('declares device-code login, quota, and honest credits:false', () => {
    const p = createQoderProvider({ fetcher: makeFetcher([]) })
    expect(p.capabilities).toMatchObject({
      loginMode: 'device-code',
      supportsRefreshToken: true,
      supportsQuota: true,
      supportsCredits: false,
      needsCaptcha: false,
    })
  })

  it('starts device-code login with a machine id bound to the session', async () => {
    const calls: string[] = []
    const fetcher = makeFetcher([{ match: QODER_DEVICE_SELECT_PATH, json: { data: { flow_id: 'f1' } } }], (u) => calls.push(u))
    const p = createQoderProvider({ fetcher })
    const started = await p.auth.beginLogin!({ provider: 'qoder', accountId: 'qoder-a1' })
    expect(started.deviceCode).toBe('f1')
    expect(calls[0]).toContain('machine_id=')
  })

  it('polls, and treats 404 as still-pending', async () => {
    const pending = createQoderProvider({
      fetcher: makeFetcher([
        { match: QODER_DEVICE_SELECT_PATH, json: {} },
        { match: QODER_POLL_PATH, status: 404 },
      ]),
    })
    await pending.auth.beginLogin!({ provider: 'qoder', accountId: 'qoder-a1' })
    expect(await pending.auth.pollLogin!('qoder-a1', 'qoder')).toMatchObject({ done: false })

    const ok = createQoderProvider({
      fetcher: makeFetcher([
        { match: QODER_DEVICE_SELECT_PATH, json: {} },
        { match: QODER_POLL_PATH, json: { data: { access_token: 'at', refresh_token: 'rt', user_id: 'u9' } } },
      ]),
    })
    await ok.auth.beginLogin!({ provider: 'qoder', accountId: 'qoder-a1' })
    const done = await ok.auth.pollLogin!('qoder-a1', 'qoder')
    expect(done).toMatchObject({ done: true, success: true })
    expect((done.credential as { machine_id: string }).machine_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('requires machine_id when importing a raw credential blob', async () => {
    const p = createQoderProvider({ fetcher: makeFetcher([]) })
    await expect(p.auth.importCredential!('qoder-a1', 'qoder', { access_token: 'a' }))
      .rejects.toMatchObject({ kind: 'NEEDS_MANUAL' })
    expect(await p.auth.importCredential!('qoder-a1', 'qoder', CRED)).toMatchObject({ refreshable: true })
  })

  it('sends {refresh_token, machine_id} on refresh and persists the rotation', async () => {
    let body: Record<string, unknown> | undefined
    const fetcher = makeFetcher(
      [{ match: QODER_REFRESH_PATH, json: { data: { access_token: 'new', refresh_token: 'new-ref' } } }],
      (_u, init) => { if (init?.body) body = JSON.parse(String(init.body)) },
    )
    const p = createQoderProvider({ fetcher })
    const result = await p.ops.refreshAccount!(ctx(), account())
    expect(body).toEqual({ refresh_token: 'ref', machine_id: CRED.machine_id })
    expect(result.refreshed).toBe(true)
    expect(result.credential).toMatchObject({ access_token: 'new', refresh_token: 'new-ref', machine_id: CRED.machine_id })
  })

  it('reads quota from the sash usage endpoint', async () => {
    const fetcher = makeFetcher([{ match: QODER_USAGE_PATH, json: { data: { remaining: 30, total: 100 } } }])
    const p = createQoderProvider({ fetcher })
    expect(await p.ops.getQuota!(ctx(), account())).toMatchObject({ known: true, remaining: 30, total: 100 })
  })

  it('reports credits as unsupported rather than faking a claim', async () => {
    const p = createQoderProvider({ fetcher: makeFetcher([]) })
    expect(await p.ops.claimCredits!(ctx(), account())).toMatchObject({ kind: 'unsupported' })
  })

  it('falls back to the product catalog (encrypted catalog is not decrypted)', async () => {
    const p = createQoderProvider({ fetcher: makeFetcher([]) })
    const models = await p.chat.listModels(ctx(), account())
    expect(models.map((m) => m.modelId)).toEqual(QODER.fallbackModels.map((m) => `qoder::${m.id}`))
    expect(models.every((m) => m.provider === 'qoder')).toBe(true)
  })

  it('fails cleanly without a uid (the encrypted path needs it)', async () => {
    const p = createQoderProvider({ fetcher: makeFetcher([]) })
    await expect(
      p.chat.chat(ctx({ ...CRED, uid: undefined }), { model: 'qfmodel', messages: [{ role: 'user', content: 'x' }], stream: false }, account()),
    ).rejects.toMatchObject({ kind: 'NEEDS_MANUAL' })
  })
})
