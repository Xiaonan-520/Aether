/**
 * Raccoon contracts.
 *
 * The main policy assertions are: only the WeChat QR path is implemented, and
 * the SMS path is refused with `needs_manual_action` (no captcha solving or
 * bypass). Also covers refresh-with-token-retention, the composite
 * already-granted test, and QR status degradation.
 */
import { describe, expect, it } from 'vitest'
import {
  RACCOON,
  RACCOON_BILLS_PATH,
  RACCOON_BALANCE_PATH,
  RACCOON_CHAT_PATH,
  RACCOON_LOGIN_GRANT_PATH,
  RACCOON_MODEL_CATALOG_PATH,
  RACCOON_QR_LOGIN_PATH,
  RACCOON_REFRESH_PATH,
} from '../src/providers/raccoon/product.js'
import {
  buildQrImageUrl,
  decodeJwtExpMs,
  generateQrCode,
  isRaccoonRefreshable,
  mergeRaccoonCredential,
  parseRaccoonEnvelope,
  parseRaccoonModelCatalog,
} from '../src/providers/raccoon/protocol.js'
import { createRaccoonProvider } from '../src/providers/raccoon/provider.js'
import type { Account } from '../src/core/types.js'
import type { ProviderCtx } from '../src/core/registry/provider.js'

function account(): Account {
  return {
    id: 'raccoon-a1', provider: 'raccoon', displayName: 'ra', status: 'active', enabled: true,
    authenticated: true, tokenExpiryAt: null, refreshable: true, credentialKey: 'CRED_RAC',
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
}

/** build a JWT with a chosen exp so expiry logic can be exercised */
function jwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `${header}.${payload}.sig`
}

const CRED = {
  access_token: jwt(Math.floor(Date.now() / 1000) + 3600),
  refresh_token: 'ref',
  office_identity: 'org-1',
  uid: 'u1',
}

function ctx(credential: unknown = CRED): ProviderCtx {
  return { provider: 'raccoon', resolveCredential: async () => ({ ref: 'r', expiresAt: null, refreshable: true, credential }) }
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

describe('raccoon protocol', () => {
  it('generates a 32-hex QR code and the WeChat login URL', () => {
    const code = generateQrCode()
    expect(code).toMatch(/^[0-9a-f]{32}$/)
    expect(generateQrCode()).not.toBe(code)
    const url = buildQrImageUrl(RACCOON, code)
    expect(url).toContain('/login/mp?')
    expect(url).toContain(`code=${code}`)
    expect(decodeURIComponent(url)).toContain('appname=商汤小浣熊官网')
  })

  it('decodes the JWT exp locally and parses the envelope', () => {
    expect(decodeJwtExpMs(jwt(1_700_000_000))).toBe(1_700_000_000_000)
    expect(decodeJwtExpMs('not-a-jwt')).toBeUndefined()
    expect(parseRaccoonEnvelope({ code: 0, data: {} }).ok).toBe(true)
    expect(parseRaccoonEnvelope({ code: 7, data: {} }).ok).toBe(false)
  })

  it('keeps the previous refresh token when the server omits a new one', () => {
    const merged = mergeRaccoonCredential({ access_token: jwt(1_800_000_000) }, CRED as never)
    expect(merged.refresh_token).toBe('ref')
    expect(merged.office_identity).toBe('org-1')
    expect(merged.expires_at).toBe('1800000000000')
  })

  it('parses the model catalog and drops invisible entries', () => {
    expect(parseRaccoonModelCatalog({ code: 0, data: { models: [{ id: 'a', name: 'A', visible: true }, { id: 'b', visible: false }] } }))
      .toEqual([{ id: 'a', name: 'A' }])
  })
})

describe('raccoon adapter — QR-only auth policy', () => {
  it('declares external-link QR login without captcha', () => {
    const p = createRaccoonProvider({ fetcher: makeFetcher([]) })
    expect(p.capabilities).toMatchObject({
      loginMode: 'external-link',
      needsCaptcha: false,
      supportsRefreshToken: true,
      supportsCredits: true,
    })
  })

  it('starts a QR login and reports pending until the QR is scanned', async () => {
    let posted: Record<string, unknown> | undefined
    const fetcher = makeFetcher(
      [{ match: RACCOON_QR_LOGIN_PATH, json: { code: 0, data: { status: 1 } } }],
      (_u, init) => { if (init?.body) posted = JSON.parse(String(init.body)) },
    )
    const p = createRaccoonProvider({ fetcher })
    const started = await p.auth.beginLogin!({ provider: 'raccoon', accountId: 'raccoon-a1' })
    expect(started.loginUrl).toContain('/login/mp?')
    expect(started.pollInterval).toBe(2)
    expect(await p.auth.pollLogin!('raccoon-a1', 'raccoon')).toMatchObject({ done: false })
    expect(String(posted?.qrcode_code)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('yields the credential once the QR status is success', async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 3600)
    const fetcher = makeFetcher([
      { match: RACCOON_QR_LOGIN_PATH, json: { code: 0, data: { status: 4, access_token: token, refresh_token: 'r2', nickname: 'nick' } } },
    ])
    const p = createRaccoonProvider({ fetcher })
    await p.auth.beginLogin!({ provider: 'raccoon', accountId: 'raccoon-a1' })
    const done = await p.auth.pollLogin!('raccoon-a1', 'raccoon')
    expect(done).toMatchObject({ done: true, success: true, displayName: 'nick' })
    expect((done.credential as { access_token: string }).access_token).toBe(token)
  })

  it('reports a canceled QR as a failure and downgrades unknown statuses to pending', async () => {
    const canceled = createRaccoonProvider({ fetcher: makeFetcher([{ match: RACCOON_QR_LOGIN_PATH, json: { code: 0, data: { status: 3 } } }]) })
    await canceled.auth.beginLogin!({ provider: 'raccoon', accountId: 'raccoon-a1' })
    expect(await canceled.auth.pollLogin!('raccoon-a1', 'raccoon')).toMatchObject({ done: true, success: false })

    const weird = createRaccoonProvider({ fetcher: makeFetcher([{ match: RACCOON_QR_LOGIN_PATH, json: { code: 0, data: { status: 99 } } }]) })
    await weird.auth.beginLogin!({ provider: 'raccoon', accountId: 'raccoon-a1' })
    expect(await weird.auth.pollLogin!('raccoon-a1', 'raccoon')).toMatchObject({ done: false })
  })

  it('refuses the SMS path instead of solving the captcha', async () => {
    const p = createRaccoonProvider({ fetcher: makeFetcher([]) })
    await expect(p.auth.importCredential!('raccoon-a1', 'raccoon', { phone: '13800000000' }))
      .rejects.toMatchObject({ kind: 'NEEDS_MANUAL' })
    await expect(p.auth.importCredential!('raccoon-a1', 'raccoon', { sms: true }))
      .rejects.toMatchObject({ kind: 'NEEDS_MANUAL' })
  })
})

describe('raccoon adapter — runtime', () => {
  it('refreshes and keeps the credential refreshable', async () => {
    let body: Record<string, unknown> | undefined
    const fetcher = makeFetcher(
      [{ match: RACCOON_REFRESH_PATH, json: { code: 0, data: { access_token: jwt(1_900_000_000) } } }],
      (_u, init) => { if (init?.body) body = JSON.parse(String(init.body)) },
    )
    const p = createRaccoonProvider({ fetcher })
    const result = await p.ops.refreshAccount!(ctx(), account())
    expect(body).toEqual({ refresh_token: 'ref' })
    expect(result.refreshed).toBe(true)
    expect(result.refreshable).toBe(true)
    expect((result.credential as { refresh_token: string }).refresh_token).toBe('ref')
  })

  it('aggregates non-stream chat and reads the balance', async () => {
    const fetcher = makeFetcher([
      { match: RACCOON_CHAT_PATH, text: SSE_BODY },
      { match: RACCOON_BALANCE_PATH, json: { code: 0, data: { balance: 1234 } } },
    ])
    const p = createRaccoonProvider({ fetcher })
    expect((await p.chat.chat(ctx(), { model: 'sn-glm-5-3', messages: [{ role: 'user', content: 'hi' }], stream: false }, account())).content).toBe('pong')
    expect(await p.ops.getQuota!(ctx(), account())).toMatchObject({ known: true, remaining: 1234 })
  })

  it('only grants the login reward when no matching bill exists', async () => {
    const grants: string[] = []
    const fresh = createRaccoonProvider({
      fetcher: makeFetcher(
        [
          { match: RACCOON_BILLS_PATH, json: { code: 0, data: { bills: [] } } },
          { match: RACCOON_LOGIN_GRANT_PATH, json: { code: 0, data: { granted: true, points: 3000 } } },
        ],
        (u) => { if (u.includes(RACCOON_LOGIN_GRANT_PATH)) grants.push(u) },
      ),
    })
    expect(await fresh.ops.claimCredits!(ctx(), account())).toMatchObject({ kind: 'success', credit: 3000 })
    expect(grants).toHaveLength(1)

    const repeat = createRaccoonProvider({
      fetcher: makeFetcher(
        [
          { match: RACCOON_BILLS_PATH, json: { code: 0, data: { bills: [{ biz_type: 'reward_grant', event_name: '桌面端登录奖励' }] } } },
          { match: RACCOON_LOGIN_GRANT_PATH, json: { code: 0, data: { granted: true } } },
        ],
        (u) => { if (u.includes(RACCOON_LOGIN_GRANT_PATH)) grants.push(u) },
      ),
    })
    expect(await repeat.ops.claimCredits!(ctx(), account())).toMatchObject({ kind: 'already_claimed' })
    // the grant endpoint must not be called when the bill already exists
    expect(grants).toHaveLength(1)
  })

  it('does not mistake the new-user gift for the login reward', async () => {
    const fetcher = makeFetcher([
      // same biz_type, different event — must NOT count as the login reward
      { match: RACCOON_BILLS_PATH, json: { code: 0, data: { bills: [{ biz_type: 'reward_grant', event_name: '新人注册礼包' }] } } },
      { match: RACCOON_LOGIN_GRANT_PATH, json: { code: 0, data: { granted: false } } },
    ])
    const p = createRaccoonProvider({ fetcher })
    expect(await p.ops.claimCredits!(ctx(), account())).toMatchObject({ kind: 'already_claimed' })
  })

  it('lists the catalog, probes health and maps auth failures', async () => {
    const ok = createRaccoonProvider({
      fetcher: makeFetcher([
        { match: RACCOON_MODEL_CATALOG_PATH, json: { code: 0, data: { models: [{ id: 'sn-glm-5-3', name: 'GLM-5.3', visible: true }] } } },
        { match: '/user_info', json: { code: 0, data: {} } },
      ]),
    })
    expect(await ok.ops.healthCheck!(ctx(), account())).toMatchObject({ ok: true })
    expect((await ok.chat.listModels(ctx(), account()))[0]).toMatchObject({ modelId: 'raccoon::sn-glm-5-3', provider: 'raccoon' })

    const bad = createRaccoonProvider({ fetcher: makeFetcher([{ match: RACCOON_CHAT_PATH, status: 401 }]) })
    await expect(bad.chat.chat(ctx(), { model: 'm', messages: [], stream: false }, account()))
      .rejects.toMatchObject({ kind: 'AUTH_INVALID' })
  })

  it('reports refreshability from the refresh token', () => {
    expect(isRaccoonRefreshable(CRED as never)).toBe(true)
    expect(isRaccoonRefreshable({ ...CRED, refresh_token: '' } as never)).toBe(false)
  })
})
