/**
 * Shared Buddy protocol tests (CodeBuddy / WorkBuddy).
 *
 * A scripted fake fetcher stands in for the Tencent endpoints so nothing
 * touches the network in CI.
 */
import { describe, expect, it, vi } from 'vitest'
import { WORKBUDDY, CODEBUDDY, resolveUserAgent } from '../src/providers/shared/buddy/product.js'
import {
  buildCredential,
  credentialExpiresAtMs,
  fetchAuthState,
  fetchBuddyModels,
  isRefreshable,
  parseAccountData,
  parseModelsFromConfig,
  parseTokenData,
  pollAccountOnce,
  pollTokenOnce,
  refreshBuddyToken,
  BuddyRefreshExpiredError,
} from '../src/providers/shared/buddy/protocol.js'

function jwt(payload: Record<string, unknown>): string {
  const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`
}

/** Build a fetcher that answers by URL substring. */
function scriptedFetcher(routes: Array<{ match: string; status?: number; body: unknown }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`no route for ${url}`)
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('buddy product config', () => {
  it('uses distinct endpoints/platforms but keeps protocol values', () => {
    expect(WORKBUDDY.endpoint).toBe('https://www.workbuddy.ai')
    expect(WORKBUDDY.platform).toBe('workbuddy-ai')
    expect(WORKBUDDY.productCode).toBe('workbuddy')
    expect(WORKBUDDY.attributionName).toBe('WorkBuddy')
    expect(CODEBUDDY.endpoint).toBe('https://copilot.tencent.com')
    expect(CODEBUDDY.platform).toBe('ide')
    expect(CODEBUDDY.productCode).toBe('codebuddy')
  })

  it('resolves the User-Agent per model family', () => {
    expect(resolveUserAgent(WORKBUDDY, 'gpt-5.1')).toContain('WorkBuddy AI')
    expect(resolveUserAgent(WORKBUDDY, 'glm-5.3')).toContain('WorkBuddy/5.5.2 WorkBuddy/5.5.2')
    expect(resolveUserAgent(WORKBUDDY, 'unknown-model')).toBe(WORKBUDDY.userAgent)
  })
})

describe('buddy token/account parsing', () => {
  it('converts relative expiresIn into an absolute timestamp', () => {
    const before = Date.now()
    const token = parseTokenData({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 })
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 50)
    expect(token.tokenType).toBe('Bearer')
  })

  it('falls back to the JWT exp when no explicit expiry is present', () => {
    const exp = Math.floor(Date.now() / 1000) + 7200
    const token = parseTokenData({ accessToken: jwt({ exp, nickname: 'nina' }) })
    expect(token.expiresAt).toBe(exp * 1000)
  })

  it('builds a credential, backfilling nickname/uid from the JWT', () => {
    const accessToken = jwt({ sub: 'user-42', nickname: 'Jet', exp: Math.floor(Date.now() / 1000) + 3600 })
    const credential = buildCredential(parseTokenData({ accessToken, refreshToken: 'r1' }), parseAccountData({}))
    expect(credential.user_id).toBe('user-42')
    expect(credential.nickname).toBe('Jet')
    expect(credential.refresh_token).toBe('r1')
    expect(isRefreshable(credential)).toBe(true)
    expect(credentialExpiresAtMs(credential)).toBeTypeOf('number')
  })

  it('reports non-refreshable credentials', () => {
    const credential = buildCredential(parseTokenData({ accessToken: 'a' }), parseAccountData({ uid: 'u' }))
    expect(isRefreshable(credential)).toBe(false)
  })
})

describe('buddy auth flow', () => {
  it('fetches auth state and polls token + account', async () => {
    const fetcher = scriptedFetcher([
      { match: '/v2/plugin/auth/state', body: { code: 0, data: { state: 'st-1', authUrl: 'https://auth.example/x' } } },
      { match: '/v2/plugin/auth/token?', body: { code: 0, data: { accessToken: 'at', refreshToken: 'rt', expiresIn: 60 } } },
      { match: '/v2/plugin/login/account', body: { code: 0, data: { uid: 'u1', type: 'personal' } } },
    ])
    const state = await fetchAuthState(WORKBUDDY, fetcher)
    expect(state).toEqual({ state: 'st-1', authUrl: 'https://auth.example/x' })
    const token = await pollTokenOnce(WORKBUDDY, state.state, fetcher)
    expect(token.ready).toBe(true)
    const account = await pollAccountOnce(WORKBUDDY, state.state, 'at', fetcher)
    expect(account.ready).toBe(true)
    expect(account.account?.uid).toBe('u1')
  })

  it('treats code 11217 (token) and 12151 (account) as not-ready, not errors', async () => {
    const tokenFetcher = scriptedFetcher([{ match: 'auth/token', status: 400, body: { code: 11217 } }])
    expect((await pollTokenOnce(WORKBUDDY, 's', tokenFetcher)).ready).toBe(false)
    const accountFetcher = scriptedFetcher([{ match: 'login/account', status: 400, body: { code: 12151 } }])
    expect((await pollAccountOnce(WORKBUDDY, 's', 'at', accountFetcher)).ready).toBe(false)
  })

  it('refreshes a token silently', async () => {
    const credential = buildCredential(parseTokenData({ accessToken: 'old', refreshToken: 'r' }), parseAccountData({}))
    const fetcher = scriptedFetcher([
      { match: 'token/refresh', body: { code: 0, data: { accessToken: 'new', refreshToken: 'r2', expiresIn: 3600 } } },
    ])
    const token = await refreshBuddyToken(WORKBUDDY, credential, fetcher)
    expect(token.accessToken).toBe('new')
    expect(token.refreshToken).toBe('r2')
  })

  it('maps an expired refresh token to BuddyRefreshExpiredError', async () => {
    const credential = buildCredential(parseTokenData({ accessToken: 'old', refreshToken: 'r' }), parseAccountData({}))
    const fetcher = scriptedFetcher([{ match: 'token/refresh', status: 401, body: { code: 401, message: 'expired' } }])
    await expect(refreshBuddyToken(WORKBUDDY, credential, fetcher)).rejects.toBeInstanceOf(BuddyRefreshExpiredError)
  })

  it('refuses to refresh without a refresh_token', async () => {
    const credential = buildCredential(parseTokenData({ accessToken: 'a' }), parseAccountData({}))
    await expect(refreshBuddyToken(WORKBUDDY, credential, vi.fn() as unknown as typeof fetch))
      .rejects.toBeInstanceOf(BuddyRefreshExpiredError)
  })
})

describe('buddy models', () => {
  it('parses model ids out of a nested /v3/config payload', () => {
    const models = parseModelsFromConfig({
      data: { configs: { models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, { id: 'glm-5.3' }] } },
    })
    expect(models.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'glm-5.3'])
    expect(models[0].name).toBe('DeepSeek V4 Flash')
    expect(models[1].name).toBe('glm-5.3')
  })

  it('falls back to the product catalog when the remote list is empty', async () => {
    const credential = buildCredential(parseTokenData({ accessToken: 'a' }), parseAccountData({}))
    const fetcher = scriptedFetcher([{ match: '/v3/config', body: { data: {} } }])
    const models = await fetchBuddyModels(WORKBUDDY, credential, fetcher)
    expect(models.length).toBeGreaterThan(0)
    expect(models.map((m) => m.id)).toContain('deepseek-v4-flash')
  })
})
