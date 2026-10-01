/**
 * Regression tests for the OpenAI-compatible `messages[].content` shape gap
 * reported by the Pi agent (`messages.N.content: Invalid input`).
 *
 * The gateway originally accepted only `content: string | null`, so the
 * standard OpenAI content-parts array was rejected before reaching the router.
 * RikkaHub happened to send plain strings, which is why it worked while the Pi
 * agent did not. These tests pin both shapes.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseChatCompletionsRequest, OpenAIApiError } from '../src/protocol/openai/parse.js'

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/pi-agent-request.json', import.meta.url), 'utf8'),
)

describe('openai content compatibility', () => {
  it('accepts content as a plain string (RikkaHub shape)', () => {
    const req = parseChatCompletionsRequest({
      model: 'm',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ],
    })
    expect(req.messages.map((x) => x.content)).toEqual(['be brief', 'hello'])
  })

  it('accepts a single text content part', () => {
    const req = parseChatCompletionsRequest({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })
    expect(req.messages[0].content).toBe('hello')
  })

  it('concatenates multiple text content parts in order', () => {
    const req = parseChatCompletionsRequest({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      ],
    })
    expect(req.messages[0].content).toBe('ab')
  })

  it('handles mixed roles and content shapes in one request', () => {
    const req = parseChatCompletionsRequest({
      model: 'm',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: 'plain' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', content: [{ type: 'text', text: 'res' }], tool_call_id: 't' },
      ],
    })
    expect(req.messages.map((x) => x.content)).toEqual(['sys', 'plain', '', 'res'])
    expect(req.messages[2].toolCalls).toEqual([{ id: 't', name: 'f', arguments: '{}' }])
  })

  it('treats an empty content-parts array and null as empty text', () => {
    const req = parseChatCompletionsRequest({
      model: 'm',
      messages: [
        { role: 'user', content: [] },
        { role: 'assistant', content: null },
      ],
    })
    expect(req.messages.map((x) => x.content)).toEqual(['', ''])
  })

  it('parses the redacted Pi agent request shape that previously failed', () => {
    const req = parseChatCompletionsRequest(fixture)
    expect(req.messages.map((x) => x.content)).toEqual([
      'You are a coding agent.',
      'list files',
      'Sure.',
      'now run it',
      'ok',
    ])
  })

  it('rejects unsupported content part types with an explicit 400', () => {
    try {
      parseChatCompletionsRequest({
        model: 'm',
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://x/y.png' } }] },
        ],
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(OpenAIApiError)
      expect((err as OpenAIApiError).status).toBe(400)
      expect((err as OpenAIApiError).message).toContain('unsupported content part type')
      expect((err as OpenAIApiError).code).toBe('unsupported_content_part')
    }
  })

  it('still rejects genuinely invalid content (numbers, malformed parts)', () => {
    expect(() =>
      parseChatCompletionsRequest({ model: 'm', messages: [{ role: 'user', content: 123 }] }),
    ).toThrow(OpenAIApiError)
    expect(() =>
      parseChatCompletionsRequest({
        model: 'm',
        messages: [{ role: 'user', content: [{ text: 'no type field' }] }],
      }),
    ).toThrow(OpenAIApiError)
    expect(() =>
      parseChatCompletionsRequest({
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 42 }] }],
      }),
    ).toThrow(OpenAIApiError)
  })
})

// ---------------------------------------------------------------------------
// End-to-end: the same content shapes must pass through the real HTTP route
// (auth → parser → router → provider adapter → OpenAI response), proving the
// fix is in the protocol layer rather than a client-specific special case.
// ---------------------------------------------------------------------------
import { MemoryStore } from '../src/store/memory-store.js'
import { CredentialCipher } from '../src/store/crypto.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { loadConfig } from '../src/config/index.js'
import { createGatewayApp } from '../src/http/app.js'
import { MockProvider, mockModels } from './fixtures/mock-provider.js'
import type { Account, ServiceContextLike } from '../src/core/types.js'
import type { ServiceContext } from '../src/service/context.js'

function httpSetup() {
  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  registry.register(
    new MockProvider({
      id: 'mock',
      chatScript: [{ type: 'result', result: { content: 'hello from mock', finishReason: 'stop' } }],
    }),
  )
  const acc: Account = {
    id: 'mock-a1', provider: 'mock', displayName: 'mock-a1', status: 'active', enabled: true,
    authenticated: true, tokenExpiryAt: null, refreshable: true, credentialKey: 'CRED_MOCK_A1',
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
  store.createAccount(acc)
  store.setCredential('CRED_MOCK_A1', cipher.encryptJson({ accessToken: 'tok' }))
  store.upsertModels(mockModels('mock'))
  const ctx: ServiceContext = {
    config: loadConfig({
      GATEWAY_API_KEY: 'gw-key-123',
      GATEWAY_SECRET: '0123456789abcdef',
      GATEWAY_ADMIN_TOKEN: 'admin-token-9',
    } as NodeJS.ProcessEnv),
    store,
    cipher,
    registry,
    router: new ModelRouter(registry, () => store.listModels()),
    pool: new AccountPool({
      listAccounts: (p) => store.listAccounts(p).map((s) => s.account),
      patchAccount: (id, patch) => void store.patchAccount(id, patch),
      hasCredential: () => true,
    }),
    now: () => Date.now(),
  } as unknown as ServiceContext
  void ({} as ServiceContextLike | undefined)
  return createGatewayApp(ctx)
}

describe('pi agent — HTTP end-to-end', () => {
  const auth = { Authorization: 'Bearer gw-key-123', 'Content-Type': 'application/json' }

  it('accepts content parts on POST /v1/chat/completions', async () => {
    const { app } = httpSetup()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'mock-model',
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message.content).toBe('hello from mock')
  })

  it('still accepts the plain-string shape (RikkaHub regression)', async () => {
    const { app } = httpSetup()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    expect(res.status).toBe(200)
  })

  it('returns a clean 400 (not a crash) for unsupported content parts', async () => {
    const { app } = httpSetup()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'mock-model',
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://x/y.png' } }] },
        ],
      }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.type).toBe('invalid_request_error')
    expect(JSON.stringify(body.error)).toContain('unsupported content part type')
  })

  it('streams correctly for a content-parts request', async () => {
    const { app } = httpSetup()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'mock-model',
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('data:')
    expect(text).toContain('[DONE]')
  })
})
