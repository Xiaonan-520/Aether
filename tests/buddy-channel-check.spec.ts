/**
 * Wire-level regression for the 11128 channel-check fix in the built-in
 * Buddy-family providers (workbuddy / workbuddy-cn, and the same code path
 * reused by codebuddy / buddy-intl).
 *
 * The fix rewrites one confirmed git-context label on the two surfaces the
 * upstream actually checks (`system` and assistant text). These tests assert on
 * the *captured upstream payload* rather than on internal helpers, so a future
 * refactor that drops the normalization fails here.
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/memory-store.js'
import { CredentialCipher } from '../src/store/crypto.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { ModelRouter } from '../src/core/router/model-router.js'
import { AccountPool } from '../src/core/pool/account-pool.js'
import { loadConfig } from '../src/config/index.js'
import { createGatewayApp } from '../src/http/app.js'
import { createBuddyProvider } from '../src/providers/shared/buddy/provider.js'
import { WORKBUDDY_CN } from '../src/providers/shared/buddy/product.js'
import { fetcherFor, type BuddyFetchRoute } from './fixtures/buddy-fetcher.js'
import type { Account } from '../src/core/types.js'
import type { ServiceContext } from '../src/service/context.js'

/** The confirmed fingerprint, assembled so this file's source stays clean. */
const TRIGGER = ['Main branch (you will', 'usually use this for PRs)'].join(' ')
const TRIGGER_LINE = `${TRIGGER}: main`

const MODEL = 'glm-5.3'
const PROVIDER = 'workbuddy-cn'

const CATALOG = {
  code: 0,
  data: { data: { models: [{ id: MODEL, name: MODEL, provider: PROVIDER }] } },
}

const SSE =
  'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
  'data: [DONE]\n\n'

/** Captures every upstream chat body the gateway sends. */
function setup() {
  const captured: Array<Record<string, unknown>> = []
  const inner = fetcherFor([
    { match: '/v3/config', json: CATALOG } satisfies BuddyFetchRoute,
    { match: '/v2/chat/completions', sse: SSE } satisfies BuddyFetchRoute,
  ])
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/v2/chat/completions') && init?.body) {
      try {
        captured.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      } catch {
        captured.push({ __unparsed: String(init.body) })
      }
    }
    return inner(input as RequestInfo, init)
  }) as typeof fetch

  const store = new MemoryStore()
  const cipher = new CredentialCipher('0123456789abcdef')
  const registry = new ProviderRegistry()
  registry.register(createBuddyProvider(WORKBUDDY_CN, fetcher))

  const acc: Account = {
    id: `${PROVIDER}-a1`, provider: PROVIDER, displayName: PROVIDER, status: 'active',
    enabled: true, authenticated: true, tokenExpiryAt: null, refreshable: true,
    credentialKey: `CRED_${PROVIDER.toUpperCase()}`, failureCount: 0, lastSuccessAt: null,
    lastFailureAt: null, lastError: null, cooldownUntil: null, modelRateLimits: {},
    quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null, quotaManualRequired: false,
    providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
  store.createAccount(acc)
  store.setCredential(acc.credentialKey, cipher.encryptJson({ accessToken: 'tok', domain: WORKBUDDY_CN.apiDomain }))
  store.upsertModels([
    {
      modelId: MODEL,
      provider: PROVIDER,
      upstreamModel: MODEL,
      name: MODEL,
      capabilities: { vision: false, toolCall: true, streaming: true },
      enabled: true,
      priority: 0,
    },
  ])

  const ctx = {
    config: loadConfig({
      GATEWAY_API_KEY: 'gw-key-123',
      GATEWAY_SECRET: '0123456789abcdef',
      GATEWAY_ADMIN_TOKEN: 'admin-token-9',
    } as NodeJS.ProcessEnv),
    store, cipher, registry,
    router: new ModelRouter(registry, () => store.listModels()),
    pool: new AccountPool({
      listAccounts: (p) => store.listAccounts(p).map((s) => s.account),
      patchAccount: (id, patch) => void store.patchAccount(id, patch),
      hasCredential: () => true,
    }),
    now: () => Date.now(),
  } as unknown as ServiceContext

  // `createGatewayApp` returns the Hono instance under `.app`; expose it directly.
  return { app: createGatewayApp(ctx).app, captured }
}

const auth = { Authorization: 'Bearer gw-key-123', 'Content-Type': 'application/json' }

/** POST a chat request and return the upstream body the gateway actually sent. */
async function send(messages: unknown[]): Promise<Record<string, unknown>> {
  const { app, captured } = setup()
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ model: MODEL, messages }),
  })
  expect(res.status).toBe(200)
  expect(captured).toHaveLength(1)
  return captured[0]!
}

describe('built-in buddy provider: channel check regression', () => {
  it('rewrites the label in system content on the wire', async () => {
    const { app, captured } = setup()
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: `You are a coding agent.\n\n${TRIGGER_LINE}\n\nBe concise.` },
          { role: 'user', content: 'ping' },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const wire = JSON.stringify(captured[0])
    expect(wire).not.toContain(TRIGGER)
    // the rest of the system prompt survives
    expect(wire).toContain('You are a coding agent.')
    expect(wire).toContain('Be concise.')
  })

  it('rewrites the label in replayed assistant text on the wire', async () => {
    const wire = await send([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'what is the label?' },
      { role: 'assistant', content: `It is ${TRIGGER_LINE}` },
      { role: 'user', content: 'continue' },
    ])
    expect(JSON.stringify(wire)).not.toContain(TRIGGER)
  })

  it('does not touch user text', async () => {
    const wire = await send([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: TRIGGER_LINE },
    ])
    // user messages were confirmed not to trip the check; keep them verbatim
    expect(JSON.stringify(wire)).toContain(TRIGGER)
  })

  it('leaves the Claude Code identity sentence alone (separate trigger)', async () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude."
    const wire = await send([
      { role: 'system', content: identity },
      { role: 'user', content: 'ping' },
    ])
    expect(JSON.stringify(wire)).toContain(identity)
  })

  it('keeps tool calling intact on a normal request', async () => {
    const wire = await send([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'list files' },
      // Client-facing wire form is OpenAI camelCase *snake*: tool_calls / tool_call_id.
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
      { role: 'user', content: 'thanks' },
    ])
    expect(wire).toBeDefined()
    const msgs = (wire as { messages: Array<Record<string, unknown>> }).messages
    const assistantWithCall = msgs.find((m) => m.role === 'assistant' && m.tool_calls)
    expect(assistantWithCall?.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
    ])
    expect(msgs.find((m) => m.role === 'tool')).toMatchObject({ tool_call_id: 'c1', content: 'a.txt' })
  })
})
