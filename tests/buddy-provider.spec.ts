/**
 * WorkBuddy / CodeBuddy adapter tests: registration, login, chat, streaming,
 * models and error normalization — all against a scripted fetcher.
 */
import { describe, expect, it, vi } from 'vitest'
import { createWorkBuddyProvider } from '../src/providers/workbuddy/index.js'
import { createCodeBuddyProvider } from '../src/providers/codebuddy/index.js'
import { buildCredential, parseAccountData, parseTokenData } from '../src/providers/shared/buddy/protocol.js'
import { UpstreamError } from '../src/core/errors/upstream-error.js'
import type { Account } from '../src/core/types.js'
import type { ProviderCtx } from '../src/core/registry/provider.js'

function account(id = 'workbuddy-a1', provider = 'workbuddy'): Account {
  return {
    id, provider, displayName: id, status: 'active', enabled: true, authenticated: true,
    tokenExpiryAt: null, refreshable: true, credentialKey: `CRED_${id.toUpperCase()}`,
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
}

const CREDENTIAL = buildCredential(
  parseTokenData({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600, domain: 'www.workbuddy.ai' }),
  parseAccountData({ uid: 'u1', nickname: 'Nina', type: 'personal' }),
)

function ctxFor(provider: string): ProviderCtx {
  return {
    provider,
    resolveCredential: async () => ({ ref: 'CRED', expiresAt: null, refreshable: true, credential: CREDENTIAL }),
  }
}

/** Fetcher keyed by URL substring; SSE routes return raw text. */
function fetcherFor(routes: Array<{ match: string; status?: number; json?: unknown; text?: string; contentType?: string }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) return new Response('not found', { status: 404 })
    if (route.text !== undefined) {
      return new Response(route.text, { status: route.status ?? 200, headers: { 'content-type': route.contentType ?? 'text/event-stream' } })
    }
    return new Response(JSON.stringify(route.json ?? {}), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

describe('buddy provider registration', () => {
  it('exposes workbuddy and codebuddy as distinct providers on one protocol', () => {
    const workbuddy = createWorkBuddyProvider()
    const codebuddy = createCodeBuddyProvider()
    expect(workbuddy.id).toBe('workbuddy')
    expect(workbuddy.displayName).toBe('WorkBuddy')
    expect(codebuddy.id).toBe('codebuddy')
    expect(codebuddy.displayName).toBe('CodeBuddy')
    // same capability shape, different identity
    expect(workbuddy.capabilities).toEqual(codebuddy.capabilities)
    expect(workbuddy.capabilities.loginMode).toBe('external-link')
    expect(workbuddy.capabilities.protocol).toBe('openai-chat')
    expect(workbuddy.capabilities.needsCaptcha).toBe(false)
    expect(workbuddy.capabilities.supportsCredits).toBe(true)
  })
})

describe('buddy login flow', () => {
  it('begins a login with an authorization URL and polls to success', async () => {
    const fetcher = fetcherFor([
      { match: '/v2/plugin/auth/state', json: { code: 0, data: { state: 'st-1', authUrl: 'https://auth.example/go' } } },
      { match: '/v2/plugin/auth/token', json: { code: 0, data: { accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 } } },
      { match: '/v2/plugin/login/account', json: { code: 0, data: { uid: 'u9', type: 'personal' } } },
    ])
    const provider = createWorkBuddyProvider(fetcher)
    const started = await provider.auth.beginLogin!({ provider: 'workbuddy', accountId: 'acct-1' })
    expect(started.loginUrl).toBe('https://auth.example/go')
    expect(started.expiresIn).toBeGreaterThan(0)

    const polled = await provider.auth.pollLogin!('acct-1', 'workbuddy')
    expect(polled.done).toBe(true)
    expect(polled.success).toBe(true)
    const credential = polled.credential as { access_token: string; refresh_token: string; user_id: string }
    expect(credential.access_token).toBe('at')
    expect(credential.refresh_token).toBe('rt')
    expect(credential.user_id).toBe('u9')
    expect(polled.expiresAt).toBeTypeOf('number')
  })

  it('returns pending while the user has not finished authorizing', async () => {
    const fetcher = fetcherFor([
      { match: '/v2/plugin/auth/state', json: { code: 0, data: { state: 's', authUrl: 'https://a' } } },
      { match: '/v2/plugin/auth/token', status: 400, json: { code: 11217 } },
    ])
    const provider = createWorkBuddyProvider(fetcher)
    await provider.auth.beginLogin!({ provider: 'workbuddy', accountId: 'acct-2' })
    const polled = await provider.auth.pollLogin!('acct-2', 'workbuddy')
    expect(polled.done).toBe(false)
  })

  it('reports an error for an unknown login session', async () => {
    const provider = createWorkBuddyProvider()
    const polled = await provider.auth.pollLogin!('nope', 'workbuddy')
    expect(polled.done).toBe(false)
    expect(polled.error).toMatch(/session/)
  })
})

describe('buddy chat', () => {
  it('forwards an OpenAI request and aggregates the SSE for a non-stream client', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi "}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"there"}}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetcher = fetcherFor([{ match: '/v2/chat/completions', text: sse }])
    const provider = createWorkBuddyProvider(fetcher)
    const result = await provider.chat.chat(ctxFor('workbuddy'), { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: false }, account())
    expect(result.content).toBe('hi there')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 3 })

    // the upstream body must be OpenAI-shaped, with attribution headers
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://www.workbuddy.ai/v2/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer access-1')
    expect(headers['X-Product-Code']).toBe('workbuddy')
    expect(headers['X-Product']).toBe('WorkBuddy')
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'glm-5.3' })
  })

  it('streams upstream OpenAI deltas as canonical chunks', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetcher = fetcherFor([{ match: '/v2/chat/completions', text: sse }])
    const provider = createWorkBuddyProvider(fetcher)
    const chunks = []
    for await (const chunk of provider.chat.stream(ctxFor('workbuddy'), { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true }, account())) {
      chunks.push(chunk)
    }
    expect(chunks.map((c) => c.text).join('')).toBe('Hello')
    expect(chunks.at(-1)?.finishReason).toBe('stop')
    expect(chunks.some((c) => c.usage?.completionTokens === 2)).toBe(true)
  })

  it('carries reasoning deltas through', async () => {
    const sse = 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\ndata: [DONE]\n\n'
    const fetcher = fetcherFor([{ match: '/v2/chat/completions', text: sse }])
    const provider = createWorkBuddyProvider(fetcher)
    const chunks = []
    for await (const chunk of provider.chat.stream(ctxFor('workbuddy'), { model: 'glm-5.3', messages: [{ role: 'user', content: 'x' }], stream: true }, account())) {
      chunks.push(chunk)
    }
    expect(chunks.some((c) => c.reasoning === 'thinking')).toBe(true)
  })

  it('normalizes a 401 into an AUTH_INVALID upstream error', async () => {
    const fetcher = fetcherFor([{ match: '/v2/chat/completions', status: 401, text: 'unauthorized' }])
    const provider = createWorkBuddyProvider(fetcher)
    await expect(
      provider.chat.chat(ctxFor('workbuddy'), { model: 'glm-5.3', messages: [{ role: 'user', content: 'x' }], stream: false }, account()),
    ).rejects.toMatchObject({ kind: 'AUTH_INVALID' })
  })

  it('fails with AUTH_INVALID when there is no credential', async () => {
    const provider = createWorkBuddyProvider()
    const ctx: ProviderCtx = { provider: 'workbuddy', resolveCredential: async () => undefined }
    await expect(
      provider.chat.chat(ctx, { model: 'glm-5.3', messages: [{ role: 'user', content: 'x' }], stream: false }, account()),
    ).rejects.toBeInstanceOf(UpstreamError)
  })
})

describe('buddy models and quota', () => {
  it('lists models from /v3/config', async () => {
    const fetcher = fetcherFor([
      { match: '/v3/config', json: { data: { models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] } } },
    ])
    const provider = createWorkBuddyProvider(fetcher)
    const models = await provider.chat.listModels(ctxFor('workbuddy'), account())
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ modelId: 'glm-5.3', provider: 'workbuddy', upstreamModel: 'glm-5.3' })
  })

  it('reports quota as unknown rather than inventing numbers', async () => {
    const provider = createWorkBuddyProvider()
    const quota = await provider.ops.getQuota!(ctxFor('workbuddy'), account())
    expect(quota.known).toBe(false)
    expect(quota.remaining).toBeNull()
  })
})

describe('buddy upstream compatibility contract', () => {
  const SSE_OK = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

  function lastBody(fetcher: ReturnType<typeof fetcherFor>): Record<string, unknown> {
    const calls = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
    return JSON.parse(String(calls.at(-1)![1].body)) as Record<string, unknown>
  }

  it('stream:true + existing system — keeps the client system prompt, upstream stream=true', async () => {
    const fetcher = fetcherFor([{ match: '/v2/chat/completions', text: SSE_OK }])
    const provider = createWorkBuddyProvider(fetcher)
    const messages = [
      { role: 'system' as const, content: 'BE TERSE' },
      { role: 'user' as const, content: 'hi' },
    ]
    const chunks = []
    for await (const c of provider.chat.stream(ctxFor('workbuddy'), { model: 'glm-5.3', messages, stream: true }, account())) chunks.push(c)
    expect(chunks.map((c) => c.text).join('')).toBe('ok')
    const body = lastBody(fetcher)
    expect(body.stream).toBe(true)
    expect((body.messages as Array<{ role: string; content: string }>)[0]).toEqual({ role: 'system', content: 'BE TERSE' })
    expect((body.messages as unknown[]).length).toBe(2)
  })

  it('stream:true + no system — injects the default system prompt', async () => {
    const fetcher = fetcherFor([{ match: '/v2/chat/completions', text: SSE_OK }])
    const provider = createWorkBuddyProvider(fetcher)
    const chunks = []
    for await (const c of provider.chat.stream(ctxFor('workbuddy'), { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true }, account())) chunks.push(c)
    expect(chunks.map((c) => c.text).join('')).toBe('ok')
    const body = lastBody(fetcher)
    expect(body.stream).toBe(true)
    const messages = body.messages as Array<{ role: string; content: string }>
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toBe('You are a helpful assistant.')
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('stream:false + existing system — upstream still gets stream=true, client gets a ChatResult', async () => {
    const fetcher = fetcherFor([{ match: '/v2/chat/completions', text: SSE_OK }])
    const provider = createWorkBuddyProvider(fetcher)
    const result = await provider.chat.chat(ctxFor('workbuddy'), {
      model: 'glm-5.3', stream: false,
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }],
    }, account())
    expect(result).toEqual({ content: 'ok', finishReason: 'stop' })
    const body = lastBody(fetcher)
    expect(body.stream).toBe(true)
    expect((body.messages as Array<{ role: string }>)[0].role).toBe('system')
  })

  it('stream:false + no system — injects system, upstream stream=true, returns a ChatResult', async () => {
    const fetcher = fetcherFor([{ match: '/v2/chat/completions', text: SSE_OK }])
    const provider = createWorkBuddyProvider(fetcher)
    const result = await provider.chat.chat(ctxFor('workbuddy'), {
      model: 'glm-5.3', stream: false, messages: [{ role: 'user', content: 'hi' }],
    }, account())
    expect(result.content).toBe('ok')
    const body = lastBody(fetcher)
    expect(body.stream).toBe(true)
    expect((body.messages as Array<{ role: string; content: string }>)[0].content).toBe('You are a helpful assistant.')
  })

  it('aggregates reasoning and usage on the non-streaming path', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"answer"}}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const provider = createWorkBuddyProvider(fetcherFor([{ match: '/v2/chat/completions', text: sse }]))
    const result = await provider.chat.chat(ctxFor('workbuddy'), { model: 'glm-5.3', stream: false, messages: [{ role: 'user', content: 'x' }] }, account())
    expect(result.reasoning).toBe('think')
    expect(result.content).toBe('answer')
    expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 4 })
  })
})
