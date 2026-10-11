/**
 * LobsterAI provider contracts.
 *
 * Covers the protocol primitives (envelope, headers, credential building,
 * model/client-version parsing) and the adapter lifecycle (login → credential →
 * models → chat → stream → quota → credits → refresh → health → errors) against
 * a mocked upstream. Endpoints/header values are pinned to the verified
 * reference so a silent protocol drift fails here.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  LOBSTERAI_CHAT_PATH,
  LOBSTERAI_EXCHANGE_PATH,
  LOBSTERAI_MODELS_PATH,
  LOBSTERAI_PROFILE_SUMMARY_PATH,
  LOBSTERAI_REFRESH_PATH,
  buildLobsteraiCredential,
  buildLobsteraiLoginUrl,
  createLobsteraiLoginSession,
  isLobsteraiRefreshable,
  lobsteraiChatHeaders,
  lobsteraiModelsHeaders,
  parseClientVersionFromUpdate,
  parseLobsteraiEnvelope,
  parseLobsteraiModels,
  parseLobsteraiTokenPayload,
} from '../src/providers/lobsterai/protocol.js'
import { LOBSTERAI } from '../src/providers/lobsterai/product.js'
import { createLobsteraiProvider } from '../src/providers/lobsterai/provider.js'
import type { Account } from '../src/core/types.js'
import type { ProviderCtx } from '../src/core/registry/provider.js'

const CRED = {
  access_token: 'acc-tok',
  refresh_token: 'ref-tok',
  expires_at: String(Date.now() + 3_600_000),
  uuid: 'uuid-1',
  first_keyfrom: '1000',
  latest_keyfrom: '2000',
  uid: 'user-1',
}

function ctx(credential: unknown = CRED): ProviderCtx {
  return {
    provider: 'lobsterai',
    resolveCredential: async () => ({ ref: 'r', expiresAt: null, refreshable: true, credential }),
  }
}

function account(): Account {
  return {
    id: 'lobsterai-a1', provider: 'lobsterai', displayName: 'lob', status: 'active', enabled: true,
    authenticated: true, tokenExpiryAt: null, refreshable: true, credentialKey: 'CRED_LOB',
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
}

const SSE_BODY =
  'data: {"choices":[{"delta":{"content":"po"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"ng"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
  'data: [DONE]\n\n'

interface Route { match: string; json?: unknown; text?: string; status?: number }
function makeFetcher(routes: Route[], onCall?: (url: string, init?: RequestInit) => void) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    onCall?.(url, init)
    for (const r of routes) {
      if (!url.includes(r.match)) continue
      const status = r.status ?? 200
      if (r.text !== undefined) {
        return new Response(r.text, { status, headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(JSON.stringify(r.json ?? {}), { status, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

describe('lobsterai protocol', () => {
  it('endpoints are pinned to the verified reference paths', () => {
    expect(LOBSTERAI_EXCHANGE_PATH).toBe('/api/auth/exchange')
    expect(LOBSTERAI_REFRESH_PATH).toBe('/api/auth/refresh')
    expect(LOBSTERAI_MODELS_PATH).toBe('/api/models/available')
    expect(LOBSTERAI_CHAT_PATH).toBe('/api/proxy/v1/chat/completions')
    expect(LOBSTERAI_PROFILE_SUMMARY_PATH).toBe('/api/user/profile-summary')
    expect(LOBSTERAI.apiBase).toBe('https://lobsterai-server.youdao.com')
    expect(LOBSTERAI.userAgent).toBe('LobsterAI/0.1.0')
  })

  it('parses the {code,msg,data} envelope', () => {
    expect(parseLobsteraiEnvelope({ code: 0, msg: 'OK', data: { a: 1 } })).toMatchObject({ ok: true, code: 0 })
    expect(parseLobsteraiEnvelope({ code: 500, msg: 'boom' })).toMatchObject({ ok: false, code: 500, message: 'boom' })
    expect(parseLobsteraiEnvelope(null).ok).toBe(false)
  })

  it('builds chat/model headers with the two X-LobsterAI-Client-* identity headers', () => {
    const chat = lobsteraiChatHeaders(CRED, LOBSTERAI, '2026.9.4')
    expect(chat.Authorization).toBe('Bearer acc-tok')
    expect(chat['X-LobsterAI-Client-Capabilities']).toBe('kimi-k3-agentic-v1,thinking-level-control-v1')
    expect(chat['X-LobsterAI-Client-Version']).toBe('2026.9.4')
    const models = lobsteraiModelsHeaders(CRED, LOBSTERAI, '2026.9.4')
    // the capabilities header is required on the model endpoint (filters kimi-k3)
    expect(models['X-LobsterAI-Client-Capabilities']).toBeDefined()
  })

  it('parses tokens and preserves the install identity on rebuild', () => {
    const payload = parseLobsteraiTokenPayload({
      accessToken: 'a2',
      refreshToken: 'r2',
      expiresIn: 3600,
      user: { id: 'u9', nickname: 'nick' },
    })
    expect(payload).toBeDefined()
    const cred = buildLobsteraiCredential(payload!, { uuid: 'uuid-1', first_keyfrom: '111', latest_keyfrom: '222' }, 1_000_000)
    expect(cred.access_token).toBe('a2')
    expect(cred.refresh_token).toBe('r2')
    expect(cred.uuid).toBe('uuid-1')
    expect(cred.first_keyfrom).toBe('111')
    expect(cred.expires_at).toBe(String(1_000_000 + 3_600_000))
  })

  it('parses the model catalog and the update-endpoint version', () => {
    expect(parseLobsteraiModels({ code: 0, data: { models: [{ id: 'kimi-k3', name: 'Kimi K3', contextWindow: 100 }] } }))
      .toEqual([{ id: 'kimi-k3', name: 'Kimi K3', contextWindow: 100 }])
    expect(parseLobsteraiModels({ code: 0, data: { list: [{ id: 'x' }] } })).toEqual([{ id: 'x', name: 'x' }])
    expect(parseClientVersionFromUpdate({ data: { value: { version: '2026.9.4' } } })).toBe('2026.9.4')
    expect(parseClientVersionFromUpdate({ data: { value: { version: 'nope' } } })).toBeUndefined()
  })

  it('builds the portal login URL with an encoded loopback redirect', () => {
    const url = buildLobsteraiLoginUrl(17650, 'st', LOBSTERAI)
    expect(url).toContain('https://lobsterai.youdao.com/portal#/login?')
    expect(url).toContain('source=electron')
    expect(url).toContain(encodeURIComponent('http://127.0.0.1:17650/auth/callback'))
    const session = createLobsteraiLoginSession(1234)
    expect(session.firstKeyfrom).toBe('1234')
    expect(session.uuid).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reports refreshability from the refresh token', () => {
    expect(isLobsteraiRefreshable(CRED as never)).toBe(true)
    expect(isLobsteraiRefreshable({ ...CRED, refresh_token: '' } as never)).toBe(false)
  })
})

describe('lobsterai adapter', () => {
  it('declares capabilities without any captcha/anti-bot requirement', () => {
    const p = createLobsteraiProvider({ fetcher: makeFetcher([]) })
    expect(p.id).toBe('lobsterai')
    expect(p.capabilities).toMatchObject({
      supportsOAuth: true,
      supportsRefreshToken: true,
      supportsQuota: true,
      supportsCredits: true,
      supportsStreaming: true,
      needsCaptcha: false,
      protocol: 'openai-chat',
    })
  })

  it('lists models from the upstream catalog with client headers', async () => {
    let sawCapabilities = false
    const fetcher = makeFetcher(
      [
        { match: 'api-overmind.youdao.com', json: { data: { value: { version: '2026.9.4' } } } },
        { match: LOBSTERAI_MODELS_PATH, json: { code: 0, data: { models: [{ id: 'glm-5', name: 'GLM-5' }] } } },
      ],
      (url, init) => {
        if (url.includes(LOBSTERAI_MODELS_PATH)) {
          sawCapabilities = String((init?.headers as Record<string, string>)?.['X-LobsterAI-Client-Capabilities'] ?? '').includes('kimi-k3')
        }
      },
    )
    const p = createLobsteraiProvider({ fetcher })
    const models = await p.chat.listModels(ctx(), account())
    expect(models[0]).toMatchObject({ modelId: 'lobsterai::glm-5', provider: 'lobsterai', upstreamModel: 'glm-5' })
    expect(sawCapabilities).toBe(true)
  })

  it('falls back to the static catalog when discovery fails', async () => {
    const p = createLobsteraiProvider({ fetcher: makeFetcher([]) })
    const models = await p.chat.listModels(ctx(), account())
    expect(models.map((m) => m.modelId)).toEqual(LOBSTERAI.fallbackModels.map((m) => `lobsterai::${m.id}`))
  })

  it('aggregates a non-stream chat from the SSE-only upstream', async () => {
    const fetcher = makeFetcher([
      { match: 'api-overmind.youdao.com', json: { data: { value: { version: '2026.9.4' } } } },
      { match: LOBSTERAI_CHAT_PATH, text: SSE_BODY },
    ])
    const p = createLobsteraiProvider({ fetcher })
    const res = await p.chat.chat(ctx(), { model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }], stream: false }, account())
    expect(res.content).toBe('pong')
    expect(res.finishReason).toBe('stop')
    expect(res.usage).toEqual({ promptTokens: 5, completionTokens: 2 })
  })

  it('always requests stream:true upstream even for non-stream clients', async () => {
    let body: Record<string, unknown> | undefined
    const fetcher = makeFetcher(
      [
        { match: 'api-overmind.youdao.com', json: { data: { value: { version: '2026.9.4' } } } },
        { match: LOBSTERAI_CHAT_PATH, text: SSE_BODY },
      ],
      (_url, init) => {
        if (init?.body) body = JSON.parse(String(init.body))
      },
    )
    const p = createLobsteraiProvider({ fetcher })
    await p.chat.chat(ctx(), { model: 'glm-5', messages: [{ role: 'user', content: 'x' }], stream: false }, account())
    expect(body?.stream).toBe(true)
  })

  it('streams canonical chunks and stops at [DONE]', async () => {
    const fetcher = makeFetcher([
      { match: 'api-overmind.youdao.com', json: { data: { value: { version: '2026.9.4' } } } },
      { match: LOBSTERAI_CHAT_PATH, text: SSE_BODY },
    ])
    const p = createLobsteraiProvider({ fetcher })
    const chunks = []
    for await (const c of p.chat.stream(ctx(), { model: 'glm-5', messages: [{ role: 'user', content: 'x' }], stream: true }, account())) {
      chunks.push(c)
    }
    expect(chunks.map((c) => c.text).join('')).toBe('pong')
    expect(chunks.at(-1)?.finishReason).toBe('stop')
  })

  it('maps upstream auth failures to a normalized error', async () => {
    const fetcher = makeFetcher([
      { match: 'api-overmind.youdao.com', json: { data: { value: { version: '2026.9.4' } } } },
      { match: LOBSTERAI_CHAT_PATH, status: 401, json: { code: 401, msg: 'bad token' } },
    ])
    const p = createLobsteraiProvider({ fetcher })
    await expect(
      p.chat.chat(ctx(), { model: 'glm-5', messages: [{ role: 'user', content: 'x' }], stream: false }, account()),
    ).rejects.toMatchObject({ kind: 'AUTH_INVALID', status: 401 })
  })

  it('rotates the refresh token and returns the new credential for persistence', async () => {
    const fetcher = makeFetcher([
      { match: 'api-overmind.youdao.com', json: { data: { value: { version: '2026.9.4' } } } },
      { match: LOBSTERAI_REFRESH_PATH, json: { code: 0, data: { accessToken: 'new-acc', refreshToken: 'new-ref', expiresIn: 7200 } } },
    ])
    const p = createLobsteraiProvider({ fetcher })
    const result = await p.ops.refreshAccount!(ctx(), account())
    expect(result.refreshed).toBe(true)
    expect(result.credential).toMatchObject({ access_token: 'new-acc', refresh_token: 'new-ref', uuid: 'uuid-1' })
  })

  it('reads credit balance and only claims when the activity allows it', async () => {
    const claimCalls: string[] = []
    const fetcher = makeFetcher(
      [
        { match: 'api-overmind.youdao.com', json: { data: { value: { version: '2026.9.4' } } } },
        {
          match: '/api/client-activities/slot',
          json: { code: 0, data: { slotState: 'available', activityCode: 'act1' } },
        },
        { match: '/context', json: { code: 0, data: { state: { claimedToday: false }, actions: [{ type: 'check_in', reward: 20 }] } } },
        { match: '/actions/check_in', json: { code: 0, data: {} } },
        { match: LOBSTERAI_PROFILE_SUMMARY_PATH, json: { code: 0, data: { credits: 42, totalCredits: 100 } } },
      ],
      (url) => { if (url.includes('/actions/check_in')) claimCalls.push(url) },
    )
    const p = createLobsteraiProvider({ fetcher })
    const quota = await p.ops.getQuota!(ctx(), account())
    expect(quota).toMatchObject({ known: true, remaining: 42, total: 100 })
    const outcome = await p.ops.claimCredits!(ctx(), account())
    expect(outcome).toMatchObject({ kind: 'success', credit: 20 })
    expect(claimCalls).toHaveLength(1)
  })

  it('does not claim when the activity is unavailable or already claimed', async () => {
    const noClaim = vi.fn((url: string) => url)
    const unavailable = createLobsteraiProvider({
      fetcher: makeFetcher([
        { match: 'api-overmind.youdao.com', json: { data: { value: { version: '2026.9.4' } } } },
        { match: '/api/client-activities/slot', json: { code: 0, data: { slotState: 'hidden', activityCode: 'act1' } } },
        { match: '/actions/check_in', json: { code: 0, data: {} } },
      ], noClaim),
    })
    expect(await unavailable.ops.claimCredits!(ctx(), account())).toMatchObject({ kind: 'not_available' })

    const claimed = createLobsteraiProvider({
      fetcher: makeFetcher([
        { match: 'api-overmind.youdao.com', json: { data: { value: { version: '2026.9.4' } } } },
        { match: '/api/client-activities/slot', json: { code: 0, data: { slotState: 'available', activityCode: 'act1' } } },
        { match: '/context', json: { code: 0, data: { state: { claimedToday: true }, actions: [{ type: 'check_in' }] } } },
        { match: '/actions/check_in', json: { code: 0, data: {} } },
      ], noClaim),
    })
    expect(await claimed.ops.claimCredits!(ctx(), account())).toMatchObject({ kind: 'already_claimed' })
    // the spy sees every fetch, so assert specifically on the claim endpoint
    expect(noClaim.mock.calls.filter(([u]) => String(u).includes('/actions/check_in'))).toHaveLength(0)
  })

  it('probes account health from the profile endpoint', async () => {
    const ok = createLobsteraiProvider({
      fetcher: makeFetcher([
        { match: 'api-overmind.youdao.com', json: { data: { value: { version: '2026.9.4' } } } },
        { match: LOBSTERAI_PROFILE_SUMMARY_PATH, json: { code: 0, data: {} } },
      ]),
    })
    expect(await ok.ops.healthCheck!(ctx(), account())).toMatchObject({ ok: true })

    const bad = createLobsteraiProvider({
      fetcher: makeFetcher([
        { match: 'api-overmind.youdao.com', json: { data: { value: { version: '2026.9.4' } } } },
        { match: LOBSTERAI_PROFILE_SUMMARY_PATH, status: 401, json: {} },
      ]),
    })
    expect(await bad.ops.healthCheck!(ctx(), account())).toMatchObject({ ok: false, error: 'HTTP 401' })
  })

  it('imports a credential from an auth code (exchange) or a ready blob', async () => {
    const byCode = createLobsteraiProvider({
      fetcher: makeFetcher([
        { match: 'api-overmind.youdao.com', json: { data: { value: { version: '2026.9.4' } } } },
        { match: LOBSTERAI_EXCHANGE_PATH, json: { code: 0, data: { accessToken: 'a', refreshToken: 'r', expiresIn: 60 } } },
      ]),
    })
    const viaCode = await byCode.auth.importCredential!('lobsterai-a1', 'lobsterai', { code: 'abc' })
    expect(viaCode.refreshable).toBe(true)

    const byBlob = createLobsteraiProvider({ fetcher: makeFetcher([]) })
    const viaBlob = await byBlob.auth.importCredential!('lobsterai-a1', 'lobsterai', CRED)
    expect(viaBlob.refreshable).toBe(true)

    await expect(byBlob.auth.importCredential!('lobsterai-a1', 'lobsterai', {})).rejects.toMatchObject({ kind: 'NEEDS_MANUAL' })
  })

  it('starts login with a portal URL and no local listening port', async () => {
    const p = createLobsteraiProvider({ fetcher: makeFetcher([]) })
    const started = await p.auth.beginLogin!({ provider: 'lobsterai', accountId: 'lobsterai-a1' })
    expect(started.loginUrl).toContain('/portal#/login?')
    expect(started.expiresIn).toBe(600)
    const poll = await p.auth.pollLogin!('lobsterai-a1', 'lobsterai')
    expect(poll.done).toBe(false)
  })
})
