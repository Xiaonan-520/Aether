/**
 * Loomy contracts: the HMAC-SHA1 signing string layout (pinned), the sms login
 * two-step, honest "no refresh" reporting, the daily-quota claim semantics
 * (`alreadyProcessed`), model filtering and the dual auth headers.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loomyContentMd5, loomyCanonicalQuery, signLoomyRequest, escapeRfc3986 } from '../src/providers/loomy/sign.js'
import {
  LOOMY,
  LOOMY_CHAT_PATH,
  LOOMY_CHECK_CODE_PATH,
  LOOMY_FIRST_LOGIN_PATH,
  LOOMY_MODELS_PATH,
  LOOMY_POINTS_RECORDS_PATH,
  LOOMY_SEND_CODE_PATH,
} from '../src/providers/loomy/product.js'
import {
  isLoomyExpired,
  isLoomyRefreshable,
  loomyBusinessHeaders,
  loomyChatHeaders,
  parseLoomyEnvelope,
  parseLoomyModels,
} from '../src/providers/loomy/protocol.js'
import { createLoomyProvider } from '../src/providers/loomy/provider.js'
import type { Account } from '../src/core/types.js'
import type { ProviderCtx } from '../src/core/registry/provider.js'

function account(): Account {
  return {
    id: 'loomy-a1', provider: 'loomy', displayName: 'lo', status: 'active', enabled: true,
    authenticated: true, tokenExpiryAt: null, refreshable: false, credentialKey: 'CRED_LOOMY',
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
}

const CRED = {
  access_token: 'a'.repeat(32),
  expires_at: String(Date.now() + 86_400_000),
  phone: '13800000000',
}

function ctx(credential: unknown = CRED): ProviderCtx {
  return { provider: 'loomy', resolveCredential: async () => ({ ref: 'r', expiresAt: null, refreshable: false, credential }) }
}

const SSE_BODY =
  'data: {"choices":[{"delta":{"content":"po"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"ng"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
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

describe('loomy signing', () => {
  it('escapes RFC3986 and computes Content-MD5 with the empty-body rule', () => {
    expect(escapeRfc3986("a b!c'd(e)f*g")).toBe('a%20b%21c%27d%28e%29f%2Ag')
    expect(loomyContentMd5('')).toBe('')
    expect(loomyContentMd5('abc')).toBe('kAFQmDzST7DWlj99KOF/cg==')
    expect(loomyCanonicalQuery({ b: '2', a: '1' })).toBe('a=1&b=2')
  })

  it('signs with `account ak:sig` and a 9-segment string ending in two newlines', () => {
    const signed = signLoomyRequest({
      accessKeyId: 'AK', accessKeySecret: 'SK', method: 'POST', path: '/login/phone/sendMsgCode',
      body: '{"base":{}}', date: 'Mon, 01 Jan 2024 00:00:00 GMT', nonce: 'NONCE',
    })
    // independently recomputed from the documented layout
    const md5 = loomyContentMd5('{"base":{}}')
    const stringToSign = ['POST', '%2Flogin%2Fphone%2FsendMsgCode', '', md5, 'application/json', 'Mon, 01 Jan 2024 00:00:00 GMT', 'NONCE', '', ''].join('\n')
    const expected = createHmac('sha1', 'SK').update(stringToSign, 'utf8').digest('base64')
    expect(signed.Authorization).toBe(`account AK:${expected}`)
    expect(signed['Content-MD5']).toBe(md5)
    expect(signed.Date).toBe('Mon, 01 Jan 2024 00:00:00 GMT')
    // the string must end with two newlines (two empty trailing segments)
    expect(stringToSign.endsWith('\n\n')).toBe(true)
  })

  it('omits Content-MD5 when the body is empty', () => {
    const signed = signLoomyRequest({ accessKeyId: 'AK', accessKeySecret: 'SK', method: 'GET', path: '/models' })
    expect(signed['Content-MD5']).toBeUndefined()
  })
})

describe('loomy protocol', () => {
  it('uses the lowercase token header for business endpoints and both for chat', () => {
    expect(loomyBusinessHeaders('tok')).toEqual({ Accept: 'application/json', token: 'tok' })
    const chat = loomyChatHeaders('tok')
    expect(chat.Authorization).toBe('Bearer tok')
    expect(chat.token).toBe('tok')
  })

  it('parses the envelope and keeps only type=chat models', () => {
    expect(parseLoomyEnvelope({ code: '000000', data: {} }).ok).toBe(true)
    expect(parseLoomyEnvelope({ code: '100002', data: {} }).ok).toBe(false)
    const models = parseLoomyModels({
      code: '000000',
      data: { data: [{ id: 'minimax-m3', name: 'MiniMax M3', type: 'chat' }, { id: 'img', type: 'image' }] },
    })
    expect(models).toEqual([{ id: 'minimax-m3', name: 'MiniMax M3' }])
  })

  it('honestly reports no refresh and treats a missing expiry as valid', () => {
    expect(isLoomyRefreshable()).toBe(false)
    expect(isLoomyExpired({ ...CRED, expires_at: undefined } as never)).toBe(false)
    expect(isLoomyExpired({ ...CRED, expires_at: String(Date.now() - 1000) } as never)).toBe(true)
  })
})

describe('loomy adapter', () => {
  it('declares sms login with no refresh', () => {
    const p = createLoomyProvider({ fetcher: makeFetcher([]) })
    expect(p.capabilities).toMatchObject({ loginMode: 'sms', supportsRefreshToken: false, supportsCredits: true, needsCaptcha: false })
    expect(LOOMY_SEND_CODE_PATH).toBe('/login/phone/sendMsgCode')
    expect(LOOMY_CHECK_CODE_PATH).toBe('/login/phone/checkCode')
  })

  it('runs the two-step sms login and yields the session credential', async () => {
    const fetcher = makeFetcher([
      { match: LOOMY_SEND_CODE_PATH, json: { code: '000000', data: { msgid: 'm1' } } },
      { match: LOOMY_CHECK_CODE_PATH, json: { code: '000000', data: { session: 'f'.repeat(32) } } },
    ])
    const p = createLoomyProvider({ fetcher, now: () => 1_000_000 })
    const started = await p.auth.beginLogin!({ provider: 'loomy', accountId: 'loomy-a1', phone: '13800000000' })
    expect(started.needsManual).toBe(true)
    expect((await p.auth.pollLogin!('loomy-a1', 'loomy')).done).toBe(false)
    await p.auth.importCredential!('loomy-a1', 'loomy', { mcode: '123456' })
    const done = await p.auth.pollLogin!('loomy-a1', 'loomy')
    expect(done).toMatchObject({ done: true, success: true })
    expect((done.credential as { access_token: string }).access_token).toBe('f'.repeat(32))
  })

  it('requires a phone number before sending a code (no captcha workaround)', async () => {
    const p = createLoomyProvider({ fetcher: makeFetcher([]) })
    const started = await p.auth.beginLogin!({ provider: 'loomy', accountId: 'loomy-a1' })
    expect(started.needsManual).toBe(true)
    await expect(p.auth.importCredential!('loomy-a1', 'loomy', { mcode: '1' })).rejects.toMatchObject({ kind: 'NEEDS_MANUAL' })
  })

  it('never refreshes (returns an honest error)', async () => {
    const p = createLoomyProvider({ fetcher: makeFetcher([]) })
    const result = await p.ops.refreshAccount!(ctx(), account())
    expect(result).toMatchObject({ refreshed: false, refreshable: false })
    expect(result.error).toContain('re-login')
  })

  it('aggregates non-stream chat and sends both auth headers', async () => {
    let headers: Record<string, string> = {}
    const fetcher = makeFetcher([{ match: LOOMY_CHAT_PATH, text: SSE_BODY }], (_u, init) => {
      headers = (init?.headers as Record<string, string>) ?? {}
    })
    const p = createLoomyProvider({ fetcher })
    const res = await p.chat.chat(ctx(), { model: 'minimax-m3', messages: [{ role: 'user', content: 'hi' }], stream: false }, account())
    expect(res.content).toBe('pong')
    expect(headers.Authorization).toBe(`Bearer ${CRED.access_token}`)
    expect(headers.token).toBe(CRED.access_token)
  })

  it('maps the daily quota reset and its idempotent alreadyProcessed case', async () => {
    const fresh = createLoomyProvider({
      fetcher: makeFetcher([{ match: LOOMY_FIRST_LOGIN_PATH, json: { code: '000000', data: { dailyQuota: 5000, dailyConsumed: 0 } } }]),
    })
    expect(await fresh.ops.claimCredits!(ctx(), account())).toMatchObject({ kind: 'success', credit: 5000 })

    const repeat = createLoomyProvider({
      fetcher: makeFetcher([{ match: LOOMY_FIRST_LOGIN_PATH, json: { code: '000000', data: { alreadyProcessed: true, dailyQuota: 5000 } } }]),
    })
    expect(await repeat.ops.claimCredits!(ctx(), account())).toMatchObject({ kind: 'already_claimed' })

    const expired = createLoomyProvider({ fetcher: makeFetcher([]) })
    expect(await expired.ops.claimCredits!(ctx({ ...CRED, expires_at: String(Date.now() - 1) }), account()))
      .toMatchObject({ kind: 'needs_auth' })
  })

  it('reads the read-only balance for quota', async () => {
    const fetcher = makeFetcher([
      { match: LOOMY_POINTS_RECORDS_PATH, json: { code: '000000', data: { balance: 100, dailyBalance: 50, availableBalance: 150, dailyQuota: 500 } } },
    ])
    const p = createLoomyProvider({ fetcher })
    expect(await p.ops.getQuota!(ctx(), account())).toMatchObject({ known: true, remaining: 150, total: 500 })
  })

  it('probes health and lists fallback models', async () => {
    const ok = createLoomyProvider({ fetcher: makeFetcher([{ match: LOOMY_MODELS_PATH, json: { code: '000000', data: { data: [] } } }]) })
    expect(await ok.ops.healthCheck!(ctx(), account())).toMatchObject({ ok: true })
    expect((await ok.chat.listModels(ctx(), account())).length).toBeGreaterThan(0)
    const bad = createLoomyProvider({ fetcher: makeFetcher([{ match: LOOMY_MODELS_PATH, status: 401 }]) })
    expect(await bad.ops.healthCheck!(ctx(), account())).toMatchObject({ ok: false, error: 'HTTP 401' })
  })

  it('maps chat auth failures', async () => {
    const p = createLoomyProvider({ fetcher: makeFetcher([{ match: LOOMY_CHAT_PATH, status: 401 }]) })
    await expect(
      p.chat.chat(ctx(), { model: 'm', messages: [], stream: false }, account()),
    ).rejects.toMatchObject({ kind: 'AUTH_INVALID' })
  })
})
