/**
 * ZCode provider tests: registration, Anthropic conversion, captcha gating,
 * chat/stream, OAuth login, credential import and error normalization.
 */
import { describe, expect, it, vi } from 'vitest'
import { createZCodeProvider } from '../src/providers/zcode/index.js'
import { ZCodeCaptchaManager } from '../src/providers/zcode/captcha.js'
import { toAnthropicBody, anthropicEventToChunk, fromAnthropicResponse } from '../src/providers/zcode/anthropic.js'
import { normalizeImportedCredential } from '../src/providers/zcode/auth.js'
import type { Account, ChatRequest } from '../src/core/types.js'
import type { ProviderCtx } from '../src/core/registry/provider.js'

function account(id = 'zcode-a1'): Account {
  return {
    id, provider: 'zcode', displayName: id, status: 'active', enabled: true, authenticated: true,
    tokenExpiryAt: null, refreshable: false, credentialKey: 'CRED_Z1',
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
}

function ctxWith(credential: unknown): ProviderCtx {
  return {
    provider: 'zcode',
    resolveCredential: async () => ({ ref: 'CRED_Z1', expiresAt: null, refreshable: false, credential }),
  }
}

function fetcherFor(routes: Array<{ match: string; status?: number; json?: unknown; text?: string }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) return new Response('not found', { status: 404 })
    if (route.text !== undefined) {
      return new Response(route.text, { status: route.status ?? 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(JSON.stringify(route.json ?? {}), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

const REQ: ChatRequest = { model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], stream: false }

describe('zcode provider registration', () => {
  it('declares the captcha and Anthropic protocol', () => {
    const provider = createZCodeProvider()
    expect(provider.id).toBe('zcode')
    expect(provider.capabilities.needsCaptcha).toBe(true)
    expect(provider.capabilities.protocol).toBe('anthropic-messages')
    expect(provider.capabilities.supportsRefreshToken).toBe(false)
    expect(provider.capabilities.loginMode).toBe('oauth')
  })

  it('lists the static Z.AI catalog', async () => {
    const provider = createZCodeProvider()
    const models = await provider.chat.listModels(ctxWith({ jwt_token: 'j' }), account())
    expect(models.map((m) => m.modelId)).toContain('glm-5.1')
    expect(models.every((m) => m.provider === 'zcode')).toBe(true)
  })
})

describe('anthropic conversion', () => {
  it('converts system + messages and block-array content', () => {
    const body = toAnthropicBody(
      { model: 'glm-5.1', messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }], stream: false, maxTokens: 100 },
      'GLM-5.1',
    )
    expect(body.system).toBe('be nice')
    expect(body.model).toBe('GLM-5.1')
    expect(body.max_tokens).toBe(100)
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('maps text/thinking deltas and stop reasons', () => {
    expect(anthropicEventToChunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } })).toEqual({ text: 'x' })
    expect(anthropicEventToChunk({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'r' } })).toEqual({ text: '', reasoning: 'r' })
    expect(anthropicEventToChunk({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } })).toMatchObject({ finishReason: 'length' })
    expect(anthropicEventToChunk({ type: 'message_start' })).toBeUndefined()
  })

  it('reads a non-streaming Anthropic response', () => {
    const result = fromAnthropicResponse({
      content: [{ type: 'text', text: 'answer' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 2 },
    })
    expect(result.content).toBe('answer')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({ promptTokens: 4, completionTokens: 2 })
  })
})

describe('zcode captcha gating', () => {
  it('fails with NEEDS_CAPTCHA when no token has been submitted', async () => {
    const provider = createZCodeProvider({ captcha: new ZCodeCaptchaManager(), fetcher: fetcherFor([]) })
    await expect(provider.chat.chat(ctxWith({ jwt_token: 'j' }), REQ, account())).rejects.toMatchObject({ kind: 'NEEDS_CAPTCHA' })
  })

  it('sends the verify param once a token is submitted', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('verify-xyz')
    const fetcher = fetcherFor([
      { match: 'anthropic/v1/messages', json: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
    ])
    const provider = createZCodeProvider({ captcha, fetcher })
    const result = await provider.chat.chat(ctxWith({ jwt_token: 'jwt-1' }), REQ, account())
    expect(result.content).toBe('ok')

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('zcode-plan/anthropic')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer jwt-1')
    expect(headers['X-Aliyun-Captcha-Verify-Param']).toBe('verify-xyz')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('uses the api-key endpoint when only an api_key exists', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('v')
    const fetcher = fetcherFor([{ match: 'api.z.ai/api/anthropic', json: { content: [{ type: 'text', text: 'ok' }] } }])
    const provider = createZCodeProvider({ captcha, fetcher })
    await provider.chat.chat(ctxWith({ api_key: 'sk.key' }), REQ, account())
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk.key')
  })

  it('invalidates the cache and re-surfaces NEEDS_CAPTCHA on a captcha 403', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('stale')
    const fetcher = fetcherFor([{ match: 'anthropic/v1/messages', status: 403, text: 'captcha verify failed' }])
    const provider = createZCodeProvider({ captcha, fetcher, maxCaptchaRetries: 1 })
    await expect(provider.chat.chat(ctxWith({ jwt_token: 'jwt' }), REQ, account())).rejects.toMatchObject({ kind: 'NEEDS_CAPTCHA' })
    expect(captcha.isValid()).toBe(false)
  })

  it('streams Anthropic SSE events as canonical chunks', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('v')
    const sse = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"He"}}',
      '',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"llo"}}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '',
    ].join('\n')
    const provider = createZCodeProvider({ captcha, fetcher: fetcherFor([{ match: 'anthropic/v1/messages', text: sse }]) })
    const chunks = []
    for await (const chunk of provider.chat.stream(ctxWith({ jwt_token: 'jwt' }), { ...REQ, stream: true }, account())) {
      chunks.push(chunk)
    }
    expect(chunks.map((c) => c.text).join('')).toBe('Hello')
    expect(chunks.at(-1)?.finishReason).toBe('stop')
  })

  it('normalizes a 429 into RATE_LIMIT', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('v')
    const provider = createZCodeProvider({ captcha, fetcher: fetcherFor([{ match: 'anthropic/v1/messages', status: 429, text: 'slow down' }]) })
    await expect(provider.chat.chat(ctxWith({ jwt_token: 'jwt' }), REQ, account())).rejects.toMatchObject({ kind: 'RATE_LIMIT' })
  })
})

describe('zcode login and credential import', () => {
  it('starts an OAuth flow and polls to a JWT credential', async () => {
    const fetcher = fetcherFor([
      { match: '/oauth/cli/init', json: { data: { flow_id: 'f1', authorize_url: 'https://zcode.z.ai/authorize?x=1' } } },
      { match: '/oauth/cli/poll/', json: { data: { status: 'ready', token: 'jwt-token-abc' } } },
    ])
    const provider = createZCodeProvider({ fetcher })
    const started = await provider.auth.beginLogin!({ provider: 'zcode', accountId: 'za-1' })
    expect(started.loginUrl).toContain('zcode.z.ai/authorize')
    const polled = await provider.auth.pollLogin!('za-1', 'zcode')
    expect(polled.success).toBe(true)
    expect((polled.credential as { jwt_token: string }).jwt_token).toBe('jwt-token-abc')
  })

  it('reports pending while authorization is incomplete', async () => {
    const fetcher = fetcherFor([
      { match: '/oauth/cli/init', json: { data: { flow_id: 'f2', authorize_url: 'https://a' } } },
      { match: '/oauth/cli/poll/', json: { data: { status: 'pending' } } },
    ])
    const provider = createZCodeProvider({ fetcher })
    await provider.auth.beginLogin!({ provider: 'zcode', accountId: 'za-2' })
    expect((await provider.auth.pollLogin!('za-2', 'zcode')).done).toBe(false)
  })

  it('normalizes imported credentials and rejects unusable payloads', () => {
    expect(normalizeImportedCredential({ zcodejwttoken: 'j', nickname: 'n' })).toMatchObject({ jwt_token: 'j', nickname: 'n' })
    expect(normalizeImportedCredential({ api_key: 'a.b' })).toMatchObject({ api_key: 'a.b' })
    expect(() => normalizeImportedCredential({ nothing: true })).toThrow(/jwt_token/)
  })

  it('does not claim to support refresh (static credential)', async () => {
    const provider = createZCodeProvider()
    const result = await provider.ops.refreshAccount!(ctxWith({ jwt_token: 'j' }), account())
    expect(result.refreshed).toBe(false)
    expect(result.refreshable).toBe(false)
  })

  it('parses quota when the billing endpoint responds', async () => {
    const fetcher = fetcherFor([
      { match: 'billing/current', json: { data: { remaining: 42, total: 100, resetAt: 123 } } },
      { match: 'billing/balance', json: { data: {} } },
    ])
    const provider = createZCodeProvider({ fetcher })
    const quota = await provider.ops.getQuota!(ctxWith({ jwt_token: 'j' }), account())
    expect(quota.known).toBe(true)
    expect(quota.remaining).toBe(42)
    expect(quota.total).toBe(100)
  })
})
