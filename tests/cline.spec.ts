/**
 * Cline provider contracts: the WorkOS device-code login lifecycle (pending /
 * slow_down / denied / token), no local callback port, model-catalog merge with
 * the authoritative free set, refresh rotation, quota (balance) and the
 * explicit "no daily check-in" capability honesty.
 */
import { describe, expect, it } from 'vitest'
import {
  CLINE,
  CLINE_CHAT_PATH,
  CLINE_DEVICE_AUTHENTICATE_PATH,
  CLINE_DEVICE_AUTHORIZATION_PATH,
  CLINE_MODELS_PATH,
  CLINE_RECOMMENDED_MODELS_PATH,
  CLINE_REFRESH_PATH,
  CLINE_REGISTER_PATH,
} from '../src/providers/cline/product.js'
import {
  buildClineCredential,
  clineBearerValue,
  clineRefreshBody,
  classifyClinePoll,
  parseClineDeviceAuthorization,
  parseClineTokenPayload,
} from '../src/providers/cline/protocol.js'
import { buildClineCatalog, isClineFreeModel, parseClineFreeIds } from '../src/providers/cline/models.js'
import { createClineProvider } from '../src/providers/cline/provider.js'
import type { Account } from '../src/core/types.js'
import type { ProviderCtx } from '../src/core/registry/provider.js'

const CRED = {
  access_token: 'workos:eyJabc',
  refresh_token: 'ref-tok',
  expires_at: String(Date.now() + 3_600_000),
  user_id: 'usr-1',
  email: 'a@b.c',
}

function ctx(credential: unknown = CRED): ProviderCtx {
  return {
    provider: 'cline',
    resolveCredential: async () => ({ ref: 'r', expiresAt: null, refreshable: true, credential }),
  }
}

function account(): Account {
  return {
    id: 'cline-a1', provider: 'cline', displayName: 'cl', status: 'active', enabled: true,
    authenticated: true, tokenExpiryAt: null, refreshable: true, credentialKey: 'CRED_CLINE',
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
}

const SSE_BODY =
  'data: {"choices":[{"delta":{"content":"po"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"ng"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
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

describe('cline protocol', () => {
  it('pins the verified endpoints and identity values', () => {
    expect(CLINE.apiBase).toBe('https://api.cline.bot')
    expect(CLINE.workOsBase).toBe('https://api.workos.com')
    expect(CLINE.workOsClientId).toBe('client_01K3A541FN8TA3EPPHTD2325AR')
    expect(CLINE_DEVICE_AUTHORIZATION_PATH).toBe('/user_management/authorize/device')
    expect(CLINE_DEVICE_AUTHENTICATE_PATH).toBe('/user_management/authenticate')
    expect(CLINE_REGISTER_PATH).toBe('/api/v1/auth/register')
    expect(CLINE_REFRESH_PATH).toBe('/api/v1/auth/refresh')
    expect(CLINE_CHAT_PATH).toBe('/api/v1/chat/completions')
    expect(CLINE_MODELS_PATH).toBe('/api/v1/models')
    expect(CLINE_RECOMMENDED_MODELS_PATH).toBe('/api/v1/ai/cline/recommended-models')
  })

  it('treats authorization_pending as pending and slow_down as backoff', () => {
    expect(classifyClinePoll(400, { error: 'authorization_pending' })).toEqual({ status: 'pending' })
    expect(classifyClinePoll(400, { error: 'slow_down' })).toEqual({ status: 'slow_down', intervalMs: 1000 })
    expect(classifyClinePoll(400, { error: 'access_denied' })).toMatchObject({ status: 'denied' })
    expect(classifyClinePoll(200, { access_token: 't', refresh_token: 'r' })).toMatchObject({ status: 'token', accessToken: 't' })
    // no error + no token on a 2xx is still pending, not a hard failure
    expect(classifyClinePoll(200, {})).toEqual({ status: 'pending' })
  })

  it('normalizes the device authorization and preserves the workos: bearer prefix', () => {
    const auth = parseClineDeviceAuthorization({
      device_code: 'dc', user_code: 'WXYZ', verification_uri: 'https://x/device',
      verification_uri_complete: 'https://x/device?user_code=WXYZ', expires_in: 300, interval: 5,
    })
    expect(auth).toMatchObject({ deviceCode: 'dc', userCode: 'WXYZ', expiresInMs: 300_000, intervalMs: 5_000 })
    expect(clineBearerValue('eyJabc', CLINE)).toBe('workos:eyJabc')
    expect(clineBearerValue('workos:eyJabc', CLINE)).toBe('workos:eyJabc')
  })

  it('parses the {success,data} envelope with camelCase fields and ISO expiry', () => {
    const payload = parseClineTokenPayload({
      success: true,
      data: { accessToken: 'workos:a', refreshToken: 'r', expiresAt: '2026-09-25T05:23:47.000Z', userInfo: { clineUserId: 'u1', email: 'e@x' } },
    })
    expect(payload?.accessToken).toBe('workos:a')
    expect(payload?.clineUserId).toBe('u1')
    expect(payload?.expiresAt).toBe(Date.parse('2026-09-25T05:23:47.000Z'))
    // a failure envelope without a token is not success
    expect(parseClineTokenPayload({ success: false, data: {} })).toBeUndefined()
    const cred = buildClineCredential(payload!)
    expect(cred).toMatchObject({ access_token: 'workos:a', refresh_token: 'r', user_id: 'u1', email: 'e@x' })
  })

  it('sends the non-standard camelCase refresh body', () => {
    expect(clineRefreshBody(CRED as never)).toEqual({ refreshToken: 'ref-tok', grantType: 'refresh_token' })
  })
})

describe('cline models', () => {
  it('uses recommended-models as the authoritative free set', () => {
    expect(parseClineFreeIds({ data: { free: [{ id: 'cline-free/x' }, 'y:free'] } })).toEqual(['cline-free/x', 'y:free'])
    const catalog = buildClineCatalog({
      allModels: { data: [{ id: 'anthropic/claude-sonnet-4.5' }, { id: 'nvidia/z:free' }] },
      recommended: { data: { free: [{ id: 'cline-free/gemini-3.8-flash' }] } },
    })
    const byId = new Map(catalog.map((m) => [m.id, m.isFree]))
    expect(byId.get('cline-free/gemini-3.8-flash')).toBe(true) // from free[]
    expect(byId.get('nvidia/z:free')).toBe(true) // suffix convention
    expect(byId.get('anthropic/claude-sonnet-4.5')).toBe(false)
    // the paid `/models` endpoint does not list cline-free ids, they are merged in
    expect(catalog.map((m) => m.id)).toContain('cline-free/gemini-3.8-flash')
  })

  it('classifies free ids by the documented rules only', () => {
    const remote = new Set(['only-in-remote'])
    expect(isClineFreeModel('only-in-remote', remote)).toBe(true)
    expect(isClineFreeModel('cline-free/x', new Set())).toBe(true)
    expect(isClineFreeModel('a:free', new Set())).toBe(true)
    expect(isClineFreeModel('foo:freebar', new Set())).toBe(false)
    expect(isClineFreeModel('openrouter/free', new Set())).toBe(false)
  })
})

describe('cline adapter', () => {
  it('declares device-code login with quota but no credits', () => {
    const p = createClineProvider({ fetcher: makeFetcher([]) })
    expect(p.id).toBe('cline')
    expect(p.capabilities).toMatchObject({
      supportsOAuth: true,
      supportsRefreshToken: true,
      supportsQuota: true,
      supportsCredits: false,
      loginMode: 'device-code',
      needsCaptcha: false,
      protocol: 'openai-chat',
    })
  })

  it('starts device-code login without opening a callback port', async () => {
    const calls: string[] = []
    const fetcher = makeFetcher(
      [{ match: CLINE_DEVICE_AUTHORIZATION_PATH, json: { device_code: 'dc', user_code: 'WXYZ', verification_uri: 'https://x/d', interval: 5, expires_in: 300 } }],
      (url) => calls.push(url),
    )
    const p = createClineProvider({ fetcher })
    const started = await p.auth.beginLogin!({ provider: 'cline', accountId: 'cline-a1' })
    expect(started.loginUrl).toBe('https://x/d')
    expect(started.pollInterval).toBe(5)
    // only the WorkOS device endpoint is contacted; nothing local is bound
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(CLINE.workOsBase)
  })

  it('keeps polling while pending, then registers the token on authorization', async () => {
    let pollCount = 0
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes(CLINE_DEVICE_AUTHORIZATION_PATH)) {
        return new Response(JSON.stringify({ device_code: 'dc', user_code: 'U', verification_uri: 'https://x/d', interval: 5 }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes(CLINE_DEVICE_AUTHENTICATE_PATH)) {
        pollCount += 1
        const body = pollCount < 3 ? { error: 'authorization_pending' } : { access_token: 'workos:t', refresh_token: 'r' }
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes(CLINE_REGISTER_PATH)) {
        return new Response(JSON.stringify({ success: true, data: { accessToken: 'cline-tok', refreshToken: 'cline-ref', expiresAt: '2030-01-01T00:00:00.000Z' } }), { headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    const p = createClineProvider({ fetcher })
    await p.auth.beginLogin!({ provider: 'cline', accountId: 'cline-a1' })
    expect((await p.auth.pollLogin!('cline-a1', 'cline')).done).toBe(false)
    expect((await p.auth.pollLogin!('cline-a1', 'cline')).done).toBe(false)
    const done = await p.auth.pollLogin!('cline-a1', 'cline')
    expect(done).toMatchObject({ done: true, success: true })
    expect(done.credential).toMatchObject({ access_token: 'cline-tok', refresh_token: 'cline-ref' })
    expect(done.displayName).toBeUndefined()
  })

  it('stops on a terminal device-code error', async () => {
    const fetcher = makeFetcher([
      { match: CLINE_DEVICE_AUTHORIZATION_PATH, json: { device_code: 'dc', verification_uri: 'https://x/d' } },
      { match: CLINE_DEVICE_AUTHENTICATE_PATH, json: { error: 'access_denied' } },
    ])
    const p = createClineProvider({ fetcher })
    await p.auth.beginLogin!({ provider: 'cline', accountId: 'cline-a1' })
    expect(await p.auth.pollLogin!('cline-a1', 'cline')).toMatchObject({ done: true, success: false })
  })

  it('lists models from both endpoints and marks free ones', async () => {
    const fetcher = makeFetcher([
      { match: CLINE_RECOMMENDED_MODELS_PATH, json: { data: { free: [{ id: 'cline-free/gemini-3.8-flash' }] } } },
      { match: CLINE_MODELS_PATH, json: { data: [{ id: 'anthropic/claude-sonnet-4.5' }] } },
    ])
    const p = createClineProvider({ fetcher })
    const models = await p.chat.listModels(ctx(), account())
    const map = new Map(models.map((m) => [m.modelId, m]))
    expect(map.has('cline::anthropic/claude-sonnet-4.5')).toBe(true)
    expect(JSON.parse(map.get('cline::cline-free/gemini-3.8-flash')!.metadataJson!)).toEqual({ free: true })
  })

  it('aggregates non-stream chat from the SSE-only upstream with workos bearer', async () => {
    let auth = ''
    const fetcher = makeFetcher(
      [{ match: CLINE_CHAT_PATH, text: SSE_BODY }],
      (_url, init) => { auth = String((init?.headers as Record<string, string>)?.Authorization ?? '') },
    )
    const p = createClineProvider({ fetcher })
    const res = await p.chat.chat(ctx(), { model: 'anthropic/claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }], stream: false }, account())
    expect(res.content).toBe('pong')
    expect(res.usage).toEqual({ promptTokens: 3, completionTokens: 2 })
    expect(auth).toBe('Bearer workos:eyJabc')
  })

  it('rotates the refresh token and returns the credential for persistence', async () => {
    const fetcher = makeFetcher([
      { match: CLINE_REFRESH_PATH, json: { success: true, data: { accessToken: 'workos:new', refreshToken: 'new-ref', expiresAt: '2030-01-01T00:00:00.000Z' } } },
    ])
    const p = createClineProvider({ fetcher })
    const result = await p.ops.refreshAccount!(ctx(), account())
    expect(result.refreshed).toBe(true)
    expect(result.credential).toMatchObject({ access_token: 'workos:new', refresh_token: 'new-ref', user_id: 'usr-1' })
  })

  it('reports balance as quota with raw units, and credits as unsupported', async () => {
    const fetcher = makeFetcher([{ match: '/balance', json: { success: true, data: { userId: 'usr-1', balance: 500000 } } }])
    const p = createClineProvider({ fetcher })
    const quota = await p.ops.getQuota!(ctx(), account())
    expect(quota).toMatchObject({ known: true, remaining: 500000 })
    expect(JSON.parse(quota.rawJson!)).toEqual({ balance: 500000, unit: 'raw' })
    expect(await p.ops.claimCredits!(ctx(), account())).toMatchObject({ kind: 'unsupported' })
  })

  it('reports unknown quota when there is no user id, and maps auth failures', async () => {
    const noUser = createClineProvider({ fetcher: makeFetcher([]) })
    expect(await noUser.ops.getQuota!(ctx({ ...CRED, user_id: undefined }), account())).toMatchObject({ known: false })

    const unauthorized = createClineProvider({
      fetcher: makeFetcher([{ match: CLINE_REFRESH_PATH, status: 401, json: {} }]),
    })
    await expect(unauthorized.ops.refreshAccount!(ctx(), account())).rejects.toMatchObject({ kind: 'AUTH_INVALID' })
  })
})
