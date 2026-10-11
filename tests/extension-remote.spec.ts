/**
 * Phase 1 contract tests: the remote provider seam, error mapping and the
 * conformance runner. All wire interaction goes through injected fetch stubs —
 * no real network, no containers (Phase 1 ships no runtime).
 */
import { describe, expect, it } from 'vitest'
import {
  buildRemoteProviders,
  RemoteExtensionClient,
  remoteClientTransport,
  runConformanceSuite,
} from '../src/protocol/extension/index.js'
import { extensionErrorToUpstreamError } from '../src/protocol/extension/errors.js'
import { buddyManifestFixture, zcodeManifestFixture } from './fixtures/extension-manifests.js'
import { UpstreamError } from '../src/core/errors/upstream-error.js'

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const stubFetch = (routes: Map<string, (init?: RequestInit) => Response>) => {
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`
    const handler = routes.get(key) ?? routes.get(url)
    if (!handler) throw new Error(`unexpected request: ${key}`)
    return handler(init)
  }
  return fn
}

const endpoints = { baseUrl: 'http://ext-zcode:8080', token: 'test-token' }

describe('remote provider seam (RFC §24.5)', () => {
  it('buildRemoteProviders mounts one Provider per manifest entry (buddy → 4)', () => {
    const providers = buildRemoteProviders({
      manifest: structuredClone(buddyManifestFixture),
      endpoints,
      fetch: stubFetch(new Map()),
    })
    expect(providers.map((p) => p.id)).toEqual(['workbuddy', 'workbuddy-cn', 'codebuddy', 'buddy-intl'])
    for (const p of providers) {
      expect(p.capabilities.supportsCredits).toBe(true)
      expect(typeof p.chat.stream).toBe('function')
      expect(typeof p.ops.getQuota).toBe('function')
    }
  })

  it('rejects manifests failing validation at mount time', () => {
    const bad = structuredClone(zcodeManifestFixture)
    bad.apiVersion = '2.0'
    expect(() => buildRemoteProviders({ manifest: bad, endpoints, fetch: stubFetch(new Map()) }))
      .toThrow(/apiVersion/)
  })

  it('credential import is rejected unless the manifest declares an authAction (RFC §10.3)', async () => {
    const [provider] = buildRemoteProviders({
      manifest: structuredClone(zcodeManifestFixture),
      endpoints,
      fetch: stubFetch(new Map()),
    })
    await expect(provider.auth.importCredential!('acc-1', 'zcode', { access_token: 'x' }))
      .rejects.toThrow(/auth action/)
  })

  it('with authAction declared, import payloads go opaquely to the action channel (§10.3)', async () => {
    const manifest = structuredClone(zcodeManifestFixture)
    manifest.providers[0]!.actions = [{
      id: 'submit-auth-code', httpMethod: 'POST', title: 'Submit code', mode: 'write',
      sideEffects: 'one-shot', ui: 'form',
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    }]
    manifest.providers[0]!.authAction = 'submit-auth-code'
    const routes = stubFetch(new Map<string, (init?: RequestInit) => Response>([
      [`${endpoints.baseUrl}/v1/actions/submit-auth-code`, () => new Response(JSON.stringify({ actionId: 'submit-auth-code', result: { accepted: true, display_name: 'Xiaonan' } }), { status: 200 })],
    ]))
    const [provider] = buildRemoteProviders({ manifest, endpoints, fetch: routes })
    const out = await provider.auth.importCredential!('acc-1', 'zcode', { code: 'abc' })
    expect(out.displayName).toBe('Xiaonan')
    // no credential material is returned by the structured seam
    expect(out.credential).toBeUndefined()
  })

  it('transport failures map onto TRANSPORT/TIMEOUT for Core failover', async () => {
    const unreachable = new RemoteExtensionClient({
      endpoints: { baseUrl: 'http://ext-gone:1', token: 't' },
      fetch: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' })
      },
    })
    await expect(unreachable.listAccounts()).rejects.toMatchObject({ kind: 'TRANSPORT' })

    const slow = new RemoteExtensionClient({
      endpoints,
      timeoutMs: 10,
      fetch: ((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('This operation was aborted')
          e.name = 'TimeoutError'
          reject(e)
        })
      })) as unknown as typeof fetch,
    })
    await expect(slow.listAccounts()).rejects.toMatchObject({ kind: 'TIMEOUT' })
  })

  it('protocol error bodies become UpstreamError with preserved kind', async () => {
    const client = new RemoteExtensionClient({
      endpoints,
      fetch: stubFetch(new Map([
        ['GET http://ext-zcode:8080/v1/accounts/zcode-1/quota', () => json({
          error: { kind: 'RATE_LIMIT', message: 'slow down', retryAfterMs: 30_000 },
        }, 429)],
      ])),
    })
    const err = await client.accountQuota('zcode-1').catch((e) => e)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err.kind).toBe('RATE_LIMIT')
    expect(err.retryAfterMs).toBe(30_000)
  })
})

describe('error contract (RFC §14)', () => {
  it('maps protocol error bodies onto Core UpstreamError without leaking status semantics', () => {
    const e = extensionErrorToUpstreamError({
      error: { kind: 'NEEDS_MANUAL', message: 'human required' },
    }, 'zcode')
    expect(e.kind).toBe('NEEDS_MANUAL')
    expect(e.isTerminal).toBe(true)
    expect(e.provider).toBe('zcode')
  })

  it('PROTOCOL_VIOLATION degrades to TERMINAL for request handling', () => {
    const e = extensionErrorToUpstreamError({
      error: { kind: 'PROTOCOL_VIOLATION', message: 'bad shape' },
    }, 'zcode')
    expect(e.kind).toBe('TERMINAL')
    expect(e.isTerminal).toBe(true)
  })
})

describe('chat streaming frames (RFC §11)', () => {
  const sse = (frames: string[]): Response => new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

  const streamClient = (frames: string[]) => new RemoteExtensionClient({
    endpoints,
    fetch: stubFetch(new Map([
      ['POST http://ext-zcode:8080/v1/chat', () => sse(frames)],
    ])),
  })

  const chatRequest = {
    accountId: 'zcode-1',
    model: 'glm-4.7',
    messages: [{ role: 'user' as const, content: 'hi' }],
    stream: true,
    requestId: 'req-1',
    deadlineMs: 1000,
  }

  it('yields canonical chunks then the done frame', async () => {
    const client = streamClient([
      'event: chunk\ndata: {"text":"Hel"}\n\n',
      'event: chunk\ndata: {"text":"lo"}\n\n',
      'event: done\ndata: {"finishReason":"stop","usage":{"promptTokens":1,"completionTokens":2}}\n\n',
    ])
    const chunks = []
    for await (const c of client.chatStream(chatRequest)) chunks.push(c)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toEqual({ text: 'Hel' })
    expect(chunks[2].finishReason).toBe('stop')
  })

  it('error frames throw structured UpstreamError mid-stream', async () => {
    const client = streamClient([
      'event: chunk\ndata: {"text":"par"}\n\n',
      'event: error\ndata: {"error":{"kind":"QUOTA_EXHAUSTED","message":"empty"}}\n\n',
    ])
    const chunks = []
    await expect(async () => {
      for await (const c of client.chatStream(chatRequest)) chunks.push(c)
    }).rejects.toMatchObject({ kind: 'QUOTA_EXHAUSTED' })
    expect(chunks).toHaveLength(1)
  })

  it('unknown event types are ignored (additive evolution, RFC §22)', async () => {
    const client = streamClient([
      'event: trace\ndata: {"span":"abc"}\n\n',
      'event: chunk\ndata: {"text":"ok"}\n\n',
    ])
    const chunks = []
    for await (const c of client.chatStream(chatRequest)) chunks.push(c)
    expect(chunks).toEqual([{ text: 'ok' }])
  })

  it('malformed frames fail loudly (protocol violation → TERMINAL)', async () => {
    const client = streamClient(['event: chunk\ndata: {broken\n\n'])
    await expect(async () => {
      for await (const _c of client.chatStream(chatRequest)) { /* consume */ }
    }).rejects.toMatchObject({ kind: 'TERMINAL' })
  })
})

describe('conformance suite skeleton (RFC §22.1, D8)', () => {
  it('manifest + health domains pass the zcode fixture', async () => {
    const manifest = structuredClone(zcodeManifestFixture)
    const result = await runConformanceSuite(manifest, remoteClientTransport({
      fetchManifest: async () => manifest,
      fetchHealth: async () => ({ status: 'healthy' }),
    } as never))
    expect(result.pass).toBe(true)
    const ids = result.domains.map((d) => d.domain)
    // Phase 3: all 11 domains registered; absent probes → skip-pass
    expect(ids).toEqual([
      'manifest', 'health', 'models', 'account-lifecycle', 'quota',
      'chat', 'streaming', 'errors', 'manual-actions', 'timeout', 'cancellation',
    ])
  })

  it('manifest domain catches security violations', async () => {
    const manifest = structuredClone(zcodeManifestFixture)
    manifest.security!.permissions!.privileged = true
    const result = await runConformanceSuite(manifest, remoteClientTransport({
      fetchManifest: async () => manifest,
      fetchHealth: async () => ({ status: 'healthy' }),
    } as never))
    expect(result.pass).toBe(false)
    expect(result.domains[0].checks.some((c) => c.id === 'manifest.security' && !c.pass)).toBe(true)
  })

  it('health domain rejects out-of-enum status', async () => {
    const result = await runConformanceSuite(
      structuredClone(zcodeManifestFixture),
      remoteClientTransport({
        fetchManifest: async () => structuredClone(zcodeManifestFixture),
        fetchHealth: async () => ({ status: 'kind-of-ok' }),
      } as never),
    )
    expect(result.domains.find((d) => d.domain === 'health')!.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// RemoteProvider claim / quota ops (Phase 3 credit chain, Core side)
// ---------------------------------------------------------------------------

describe('RemoteProvider ops — claim and quota over the extension protocol', () => {
  const account = (id: string) => ({
    id, provider: 'workbuddy-cn', displayName: id, status: 'active' as const, enabled: true,
    authenticated: true, tokenExpiryAt: null, refreshable: true, credentialKey: 'CRED_X',
    failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
    modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null,
    quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  })

  it('claimCredits posts to the well-known claim path and passes the outcome through', async () => {
    const routes = stubFetch(new Map<string, (init?: RequestInit) => Response>([
      [`${endpoints.baseUrl}/v1/accounts/acc-9/claim`, () => json({ outcome: { kind: 'success', credit: 5, message: '+5 credit' } })],
    ]))
    const [provider] = buildRemoteProviders({
      manifest: structuredClone(buddyManifestFixture),
      endpoints,
      fetch: routes,
    })
    const outcome = await provider.ops.claimCredits!(undefined as never, account('acc-9'))
    expect(outcome).toMatchObject({ kind: 'success', credit: 5 })
  })

  it('claim error kinds map verbatim (already_claimed / not_available / needs_auth)', async () => {
    for (const kind of ['already_claimed', 'not_available', 'needs_auth']) {
      const routes = stubFetch(new Map<string, (init?: RequestInit) => Response>([
        [`${endpoints.baseUrl}/v1/accounts/acc-9/claim`, () => json({ outcome: { kind } })],
      ]))
      const [provider] = buildRemoteProviders({
        manifest: structuredClone(buddyManifestFixture),
        endpoints,
        fetch: routes,
      })
      expect(await provider.ops.claimCredits!(undefined as never, account('acc-9'))).toMatchObject({ kind })
    }
  })

  it('claim protocol errors surface as UpstreamError (extension down)', async () => {
    const routes = stubFetch(new Map<string, (init?: RequestInit) => Response>([
      [`${endpoints.baseUrl}/v1/accounts/acc-9/claim`, () => json({ error: { kind: 'AUTH_INVALID', message: 'token rejected' } }, 401)],
    ]))
    const [provider] = buildRemoteProviders({
      manifest: structuredClone(buddyManifestFixture),
      endpoints,
      fetch: routes,
    })
    await expect(provider.ops.claimCredits!(undefined as never, account('acc-9')))
      .rejects.toMatchObject({ kind: 'AUTH_INVALID' })
  })

  it('getQuota normalizes the V1 snapshot without inventing numbers', async () => {
    const routes = stubFetch(new Map<string, (init?: RequestInit) => Response>([
      [`${endpoints.baseUrl}/v1/accounts/acc-9/quota`, () => json({
        known: true, status: 'ok', remaining: 12.5, total: 100, resetAt: null,
        resources: [{ id: 'credits', status: 'ok', remaining: 12.5, total: 100, unit: 'credits' }],
      })],
    ]))
    const [provider] = buildRemoteProviders({
      manifest: structuredClone(buddyManifestFixture),
      endpoints,
      fetch: routes,
    })
    const quota = await provider.ops.getQuota!(undefined as never, account('acc-9'))
    expect(quota).toMatchObject({ known: true, remaining: 12.5, total: 100 })
  })
})
