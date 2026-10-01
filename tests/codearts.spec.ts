/**
 * CodeArts contracts, including **known-vector** SDK-HMAC-SHA256 signature
 * tests: the canonical request and signature are pinned against independently
 * computed values so a refactor cannot silently change the signature.
 */
import { createHmac, createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildCanonicalRequest,
  hmacSha256Hex,
  sha256Hex,
  signHuaweiRequest,
} from '../src/providers/codearts/sign.js'
import {
  CODEARTS,
  CODEARTS_CHAT_PATH,
  CODEARTS_OPS_CLAIM_PATH,
  CODEARTS_OPS_CONFIRM_PATH,
  CODEARTS_OPS_DELIVERY_PATH,
  CODEARTS_SNAP_MODEL_BUILTIN_PATH,
} from '../src/providers/codearts/product.js'
import {
  isCodeArtsBenefitModel,
  isCodeArtsExpired,
  isCodeArtsRefreshable,
  parseCodeArtsCredential,
  parseCodeArtsModels,
} from '../src/providers/codearts/protocol.js'
import { createCodeArtsProvider } from '../src/providers/codearts/provider.js'
import type { Account } from '../src/core/types.js'
import type { ProviderCtx } from '../src/core/registry/provider.js'

function account(): Account {
  return {
    id: 'codearts-a1', provider: 'codearts', displayName: 'ca', status: 'active', enabled: true,
    authenticated: true, tokenExpiryAt: null, refreshable: false, credentialKey: 'CRED_CA',
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
}

const CRED = {
  access_key_id: 'AKIDEXAMPLE',
  secret_access_key: 'SECRETKEYEXAMPLE',
  security_token: 'SECURITYTOKEN',
  expires_at: String(Date.now() + 3_600_000),
}

function ctx(credential: unknown = CRED): ProviderCtx {
  return { provider: 'codearts', resolveCredential: async () => ({ ref: 'r', expiresAt: null, refreshable: false, credential }) }
}

const SSE_BODY =
  'data: {"choices":[{"delta":{"content":"po"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"ng"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n' +
  'data: [DONE]\n\n'

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

describe('codearts signing — known vectors', () => {
  const DATE = '20260925T052347Z'

  it('matches independently computed sha256/hmac values', () => {
    expect(sha256Hex('hello')).toBe(createHash('sha256').update('hello').digest('hex'))
    expect(hmacSha256Hex('key', 'data')).toBe(createHmac('sha256', 'key').update('data').digest('hex'))
  })

  it('builds the canonical request exactly as the SDK spec requires', () => {
    const headers = new Map<string, string>([
      ['host', 'example.com'],
      ['x-sdk-date', DATE],
      ['x-sdk-content-sha256', 'HASH'],
    ])
    const canonical = buildCanonicalRequest('GET', '/v1/ops/delivery', 'channel=IDE', headers, 'PAYLOAD')
    // sorted header names, blank line, signed header list, payload hash
    expect(canonical).toBe(
      ['GET', '/v1/ops/delivery', 'channel=IDE', 'host:example.com\nx-sdk-content-sha256:HASH\nx-sdk-date:' + DATE, '', 'host;x-sdk-content-sha256;x-sdk-date', 'PAYLOAD'].join('\n'),
    )
  })

  it('produces a deterministic signature for fixed input (regression pin)', () => {
    const signed = signHuaweiRequest(
      'AKIDEXAMPLE', 'SECRETKEYEXAMPLE', 'SECURITYTOKEN',
      'POST', 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim',
      new TextEncoder().encode('{"campaignId":"c1","channel":"IDE"}'),
      { 'agent-type': 'PromptCenter' },
      DATE,
    )
    expect(signed.headers['x-sdk-date']).toBe(DATE)
    expect(signed.headers.host).toBe('snap-access.cn-north-4.myhuaweicloud.com')
    expect(signed.headers['x-security-token']).toBe('SECURITYTOKEN')
    // expected value recomputed independently from the documented algorithm
    const payloadHash = createHash('sha256').update('{"campaignId":"c1","channel":"IDE"}').digest('hex')
    const headers = new Map<string, string>([
      ['agent-type', 'PromptCenter'],
      ['content-type', 'application/json'],
      ['host', 'snap-access.cn-north-4.myhuaweicloud.com'],
      ['x-sdk-content-sha256', payloadHash],
      ['x-sdk-date', DATE],
      ['x-security-token', 'SECURITYTOKEN'],
    ])
    const canonical = buildCanonicalRequest('POST', '/v1/ops/claim/', '', headers, payloadHash)
    const canonicalHash = createHash('sha256').update(canonical).digest('hex')
    const expected = createHmac('sha256', 'SECRETKEYEXAMPLE').update(`SDK-HMAC-SHA256\n${DATE}\n${canonicalHash}`).digest('hex')
    expect(signed.canonicalRequest).toBe(canonical)
    expect(signed.signature).toBe(expected)
    expect(signed.headers.Authorization).toBe(
      `SDK-HMAC-SHA256 Access=AKIDEXAMPLE,SignedHeaders=agent-type;content-type;host;x-sdk-content-sha256;x-sdk-date;x-security-token,Signature=${expected}`,
    )
  })

  it('omits content-type for GET and includes agent-type in the signed headers', () => {
    const signed = signHuaweiRequest('ak', 'sk', 'st', 'GET', 'https://h/v1/ops/delivery?channel=IDE', new Uint8Array(), { 'agent-type': 'PromptCenter' }, DATE)
    expect(signed.headers['content-type']).toBeUndefined()
    expect(signed.headers.Authorization).toContain('agent-type')
    expect(signed.headers.Authorization).toContain('SignedHeaders=agent-type;host')
  })
})

describe('codearts protocol', () => {
  it('parses nested and flat credential shapes', () => {
    expect(parseCodeArtsCredential({ credential: { access: 'A', secret: 'S', securitytoken: 'T' } }))
      .toMatchObject({ access_key_id: 'A', secret_access_key: 'S', security_token: 'T' })
    expect(parseCodeArtsCredential({ result: { accessKeyId: 'A', secretAccessKey: 'S', securityToken: 'T' } }))
      .toMatchObject({ access_key_id: 'A' })
    expect(parseCodeArtsCredential({ access_key_id: 'A', secret_access_key: 'S', security_token: 'T' }))
      .toMatchObject({ security_token: 'T' })
    expect(parseCodeArtsCredential({ credential: { access: 'A' } })).toBeUndefined()
  })

  it('parses model lists and flags benefit models', () => {
    expect(parseCodeArtsModels({ data: [{ id: 'glm-5.3', name: 'GLM-5.3' }] })).toEqual([{ id: 'glm-5.3', name: 'GLM-5.3' }])
    expect(parseCodeArtsModels({ models: [{ model: 'x' }] })).toEqual([{ id: 'x', name: 'x' }])
    expect(isCodeArtsBenefitModel('deepseek-v4-flash-0731')).toBe(true)
    expect(isCodeArtsBenefitModel('deepseek-v4-flash')).toBe(true)
    expect(isCodeArtsBenefitModel('glm-5.3')).toBe(false)
  })

  it('reports expiry and the absence of refresh', () => {
    expect(isCodeArtsRefreshable()).toBe(false)
    expect(isCodeArtsExpired({ ...CRED, expires_at: String(Date.now() - 1000) } as never)).toBe(true)
    expect(isCodeArtsExpired(CRED as never)).toBe(false)
  })
})

describe('codearts adapter', () => {
  it('declares no refresh token and the verified paths', () => {
    const p = createCodeArtsProvider({ fetcher: makeFetcher([]) })
    expect(p.capabilities).toMatchObject({ supportsRefreshToken: false, supportsCredits: true, supportsQuota: true })
    expect(CODEARTS_SNAP_MODEL_BUILTIN_PATH).toBe('/v1/model/builtin')
    expect(CODEARTS_CHAT_PATH).toBe('/chat/completions')
    expect(CODEARTS_OPS_CLAIM_PATH).toBe('/v1/ops/claim')
    expect(CODEARTS_OPS_CONFIRM_PATH).toBe('/v1/ops/confirm')
    expect(CODEARTS.agentTypeHeader).toBe('PromptCenter')
  })

  it('never claims a refresh (temporary AK/SK → re-login)', async () => {
    const p = createCodeArtsProvider({ fetcher: makeFetcher([]) })
    const result = await p.ops.refreshAccount!(ctx(), account())
    expect(result.refreshed).toBe(false)
    expect(result.refreshable).toBe(false)
    expect(result.error).toContain('re-login')
  })

  it('signs the chat request and streams', async () => {
    let auth = ''
    let extra: string | undefined
    const fetcher = makeFetcher([{ match: CODEARTS_CHAT_PATH, text: SSE_BODY }], (_u, init) => {
      const h = init?.headers as Record<string, string>
      auth = h.Authorization ?? ''
      extra = h.maas_type
    })
    const p = createCodeArtsProvider({ fetcher })
    const chunks = []
    for await (const c of p.chat.stream!(ctx(), { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true }, account())) chunks.push(c)
    expect(chunks.map((c) => c.text).join('')).toBe('pong')
    expect(auth.startsWith('SDK-HMAC-SHA256 Access=AKIDEXAMPLE')).toBe(true)
    expect(extra).toBeUndefined()
  })

  it('adds maas_type: benefit for benefit models', async () => {
    let extra: string | undefined
    const fetcher = makeFetcher([{ match: CODEARTS_CHAT_PATH, text: SSE_BODY }], (_u, init) => {
      extra = (init?.headers as Record<string, string>).maas_type
    })
    const p = createCodeArtsProvider({ fetcher })
    await p.chat.chat(ctx(), { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], stream: false }, account())
    expect(extra).toBe('benefit')
  })

  it('rejects an expired credential before calling upstream', async () => {
    const p = createCodeArtsProvider({ fetcher: makeFetcher([{ match: CODEARTS_CHAT_PATH, text: SSE_BODY }]) })
    await expect(
      p.chat.chat(ctx({ ...CRED, expires_at: String(Date.now() - 1000) }), { model: 'm', messages: [], stream: false }, account()),
    ).rejects.toMatchObject({ kind: 'TOKEN_EXPIRED' })
  })

  it('runs the four-step claim and confirms when the claim returns an id', async () => {
    const calls: string[] = []
    const fetcher = makeFetcher(
      [
        { match: CODEARTS_OPS_DELIVERY_PATH, json: { data: [{ campaignId: 'c1', claimable: true }] } },
        { match: CODEARTS_OPS_CLAIM_PATH, json: { id: 'pending-1' } },
        { match: CODEARTS_OPS_CONFIRM_PATH, json: { ok: true } },
      ],
      (u) => calls.push(u),
    )
    const p = createCodeArtsProvider({ fetcher })
    expect(await p.ops.claimCredits!(ctx(), account())).toMatchObject({ kind: 'success' })
    expect(calls.some((u) => u.includes(CODEARTS_OPS_CLAIM_PATH))).toBe(true)
    expect(calls.some((u) => u.includes(CODEARTS_OPS_CONFIRM_PATH))).toBe(true)
  })

  it('does not claim when no campaign is claimable', async () => {
    const calls: string[] = []
    const fetcher = makeFetcher([{ match: CODEARTS_OPS_DELIVERY_PATH, json: { data: [{ campaignId: 'c1', claimable: false }] } }], (u) => calls.push(u))
    const p = createCodeArtsProvider({ fetcher })
    expect(await p.ops.claimCredits!(ctx(), account())).toMatchObject({ kind: 'not_available' })
    expect(calls.some((u) => u.includes(CODEARTS_OPS_CLAIM_PATH))).toBe(false)
  })

  it('probes health and maps auth failures', async () => {
    const ok = createCodeArtsProvider({ fetcher: makeFetcher([{ match: CODEARTS_SNAP_MODEL_BUILTIN_PATH, json: { data: [] } }]) })
    expect(await ok.ops.healthCheck!(ctx(), account())).toMatchObject({ ok: true })
    const bad = createCodeArtsProvider({ fetcher: makeFetcher([{ match: CODEARTS_SNAP_MODEL_BUILTIN_PATH, status: 401 }]) })
    expect(await bad.ops.healthCheck!(ctx(), account())).toMatchObject({ ok: false, error: 'HTTP 401' })
  })

  it('implements login as manual credential import only', async () => {
    const p = createCodeArtsProvider({ fetcher: makeFetcher([]) })
    const started = await p.auth.beginLogin!({ provider: 'codearts', accountId: 'codearts-a1' })
    expect(started.loginUrl).toContain('codearts.huaweicloud.com')
    await expect(p.auth.importCredential!('codearts-a1', 'codearts', {})).rejects.toMatchObject({ kind: 'NEEDS_MANUAL' })
    expect(await p.auth.importCredential!('codearts-a1', 'codearts', CRED)).toMatchObject({ refreshable: false })
  })
})
