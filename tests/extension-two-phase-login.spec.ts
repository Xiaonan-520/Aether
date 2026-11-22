/**
 * RemoteProvider auth/ops bridges for extensions whose login is two-phase.
 *
 * zcode's OAuth flow reserves the account slot with `POST /v1/accounts` and
 * only learns the authorize URL from `POST /v1/accounts/:id/login`. Core used to
 * call just the first endpoint, so the Console always received an empty
 * `authorization_url` and no OAuth flow could be started. One-shot extensions
 * (workbuddycn) answer 404 on the second endpoint and must keep working.
 *
 * Also covers the enable/disable mirror: extensions own their account rows, so
 * Core's local flag has to be pushed to the extension explicitly.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildRemoteProviders } from '../src/protocol/extension/remote-provider.js'
import type { ExtensionManifest } from '../src/protocol/extension/manifest.js'
import type { Account } from '../src/core/types.js'

const MANIFEST = {
  apiVersion: '1.0',
  extension: { id: 'zcode', version: '1.0.0', displayName: 'ZCode (Z.AI)', description: 'test', license: 'MIT' },
  runtime: {
    port: 8080,
    healthPath: '/health',
    env: [],
    volumes: [{ name: 'state', mountPath: '/data', purpose: 'creds' }],
  },
  security: {
    permissions: {
      network: { domains: ['zcode.z.ai'] },
      filesystem: 'named-volumes-only',
      capabilities: [],
      privileged: false,
    },
  },
  providers: [
    {
      id: 'zcode',
      displayName: 'ZCode (Z.AI)',
      protocol: 'anthropic-messages',
      quotaResources: [
        { id: 'coding-plan', kind: 'tokens', unit: 'requests', displayName: 'Coding plan', fields: { remaining: true, total: true, resetAt: true } },
      ],
      capabilities: {
        supportsOAuth: true,
        supportsRefreshToken: false,
        supportsQuota: true,
        supportsCredits: false,
        supportsStreaming: true,
        supportsVision: false,
        supportsToolCall: true,
        supportsMultipleAccounts: true,
        needsCaptcha: true,
        loginMode: 'oauth',
        protocol: 'anthropic-messages',
      },
      fallbackModels: [{ id: 'glm-5.2', name: 'GLM-5.2', capabilities: { vision: false, toolCall: true, streaming: true } }],
      actions: [
        {
          id: 'claim-status',
          httpMethod: 'POST',
          title: 'Claim status',
          mode: 'read',
          sideEffects: 'none',
          ui: 'none',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          id: 'submit-captcha',
          httpMethod: 'POST',
          title: 'Submit captcha token',
          mode: 'write',
          sideEffects: 'one-shot',
          ui: 'browser',
          inputSchema: { type: 'object', properties: { verify_param: { type: 'string' } } },
        },
      ],
    },
  ],
} as unknown as ExtensionManifest

interface Call {
  method: string
  path: string
}

/** Stub extension: two-phase login, JSON bodies, recorded call log. */
function twoPhaseFetch(calls: Call[], secondPhaseStatus = 200): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, path })
    if (method === 'POST' && path === '/v1/accounts') {
      return new Response(JSON.stringify({
        accountId: 'zcode-abc', status: 'pending', authorizationUrl: null, expiresIn: 300, pollInterval: 2,
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    if (method === 'POST' && path === '/v1/accounts/zcode-abc/login') {
      if (secondPhaseStatus !== 200) {
        return new Response(JSON.stringify({ error: { kind: 'TERMINAL', message: 'no route', httpStatus: 404 } }), {
          status: secondPhaseStatus, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        accountId: 'zcode-abc',
        authorizationUrl: 'https://chat.z.ai/api/oauth/authorize?client_id=c&state=s&response_type=code',
        expiresIn: 304,
        pollInterval: 2,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (method === 'POST' && path === '/v1/actions/claim-status') {
      // Mirrors the extension: the action body IS the response (no {result}).
      return new Response(JSON.stringify({
        enabled: true,
        accounts: [{ accountId: 'zcode-abc', running: true }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (method === 'POST' && /^\/v1\/accounts\/zcode-abc\/(enable|disable)$/.test(path)) {
      return new Response(JSON.stringify({ accountId: 'zcode-abc', accepted: true, status: path.endsWith('enable') ? 'active' : 'disabled' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: { kind: 'TERMINAL', message: `no route: ${method} ${path}`, httpStatus: 404 } }), {
      status: 404, headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

function providers(fetchImpl: typeof fetch) {
  return buildRemoteProviders({
    manifest: structuredClone(MANIFEST),
    endpoints: { baseUrl: 'http://ext-zcode:8080', token: 'tok' },
    fetch: fetchImpl,
  })
}

const ACCOUNT = {
  id: 'zcode-abc',
  provider: 'zcode',
  displayName: 'acct',
  status: 'active',
  enabled: true,
  authenticated: true,
  tokenExpiryAt: null,
  refreshable: false,
  credentialKey: 'CRED_ZCODE-ABC',
  failureCount: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  cooldownUntil: null,
  modelRateLimits: {},
  quotaJson: null,
  lastQuotaAt: null,
  lastCreditClaimAt: null,
  quotaManualRequired: false,
  providerMetadataJson: null,
  createdAt: 0,
  updatedAt: 0,
} as unknown as Account

const NO_CTX = { provider: 'zcode', resolveCredential: async () => undefined }

afterEach(() => {
  /* nothing global to reset */
})

describe('remote login bridge', () => {
  it('falls through to the two-phase login endpoint when create returns no URL', async () => {
    const calls: Call[] = []
    const [provider] = providers(twoPhaseFetch(calls))
    const started = await provider!.auth.beginLogin!({ provider: 'zcode', accountId: 'zcode-abc' })

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/accounts',
      'POST /v1/accounts/zcode-abc/login',
    ])
    expect(started.loginUrl).toContain('chat.z.ai/api/oauth/authorize')
    expect(started.expiresIn).toBe(300)
    expect(started.needsManual).toBe(true)
  })

  it('keeps the create response when the extension has no second phase (404)', async () => {
    const calls: Call[] = []
    const [provider] = providers(twoPhaseFetch(calls, 404))
    const started = await provider!.auth.beginLogin!({ provider: 'zcode', accountId: 'zcode-abc' })

    // One-shot extensions (workbuddycn) still answer the second call; it must
    // not turn a working login into a failure.
    expect(calls).toHaveLength(2)
    expect(started.loginUrl).toBeUndefined()
    expect(started.needsManual).toBe(true)
  })

  it('propagates a non-404 second-phase failure', async () => {
    const [provider] = providers((async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && path === '/v1/accounts') {
        return new Response(JSON.stringify({ accountId: 'zcode-abc', status: 'pending', authorizationUrl: null }), {
          status: 201, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: { kind: 'UPSTREAM_5XX', message: 'boom', httpStatus: 502 } }), {
        status: 502, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)

    await expect(provider!.auth.beginLogin!({ provider: 'zcode', accountId: 'zcode-abc' }))
      .rejects.toThrow(/boom/)
  })
})

describe('remote enable/disable bridge', () => {
  it('mirrors the operator decision into the extension', async () => {
    const calls: Call[] = []
    const [provider] = providers(twoPhaseFetch(calls))

    await provider!.ops.setAccountEnabled!(NO_CTX, ACCOUNT, false)
    await provider!.ops.setAccountEnabled!(NO_CTX, ACCOUNT, true)

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/accounts/zcode-abc/disable',
      'POST /v1/accounts/zcode-abc/enable',
    ])
  })
})

describe('remote claim-status bridge', () => {
  // Regression: the bridge returned `res.result`, but invokeAction resolves to
  // the action body itself, so the Console silently saw an empty claim list for
  // a provider that was claiming on its own timer.
  it('returns the action body, not a wrapped result', async () => {
    const calls: Call[] = []
    const [provider] = providers(twoPhaseFetch(calls))

    const status = await provider!.ops.getClaimStatus!(NO_CTX, ACCOUNT) as {
      enabled: boolean
      accounts: Array<{ accountId: string; running: boolean }>
    }

    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/v1/actions/claim-status' })
    expect(status.enabled).toBe(true)
    expect(status.accounts[0]).toMatchObject({ accountId: 'zcode-abc', running: true })
  })
})
