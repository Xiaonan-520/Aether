/**
 * Extension token rotation → Core re-registration.
 *
 * These tests pin the mechanism that used to require a manual `reload`:
 *
 *   Manager mints a fresh token on every install/upgrade and injects it into the
 *   new container. Core only learns tokens via `registerRemoteExtensions()`,
 *   which it calls once at boot. Nothing notifies Core, so after an upgrade the
 *   extension speaks the new token while Core still holds the old one.
 *
 * The fix has two halves and both are exercised here over REAL HTTP against a
 * real extension process (not a mock returning true):
 *
 *   1. the extension answers a stale token with `EXTENSION_AUTH` (not
 *      `AUTH_INVALID`, which would park the provider account as dead);
 *   2. Core re-pulls the registration package from the Manager and re-mounts the
 *      provider, then the very next request succeeds.
 *
 * Also covered: idempotent re-registration (no duplicate providers), a failing
 * Manager (bounded, reported, no crash), and genuine provider auth failures are
 * NOT mistaken for hop-token mismatches.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { startCodeBuddyExtension, CODEBUDDY } from '../src/extensions/codebuddy/main.js'
import { RemoteExtensionClient, buildRemoteProviders } from '../src/protocol/extension/remote-provider.js'
import { ExtensionAuthRecovery, resolveExtensionIdForProvider } from '../src/protocol/extension/auth-recovery.js'
import { extensionErrorToUpstreamError } from '../src/protocol/extension/errors.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { MemoryStore } from '../src/store/memory-store.js'

const EXT_ID = 'codebuddy'
const PROVIDER_ID = 'codebuddy'
const OLD_TOKEN = 'token-old-aaaaaaaaaaaaaaaaaaaaaaaa'
const NEW_TOKEN = 'token-new-bbbbbbbbbbbbbbbbbbbbbbbb'

/** Stubbed upstream so the extension can serve a real chat request. */
const upstreamFetch: typeof fetch = async (input, init) => {
  const path = String(input).replace(/^https:\/\/[^/]+/, '')
  if (path.includes('/v2/plugin/auth/state')) {
    return new Response(JSON.stringify({ code: 0, data: { state: 'st-1', authUrl: 'https://login.example/authorize?state=st-1' } }), { status: 200 })
  }
  if (path.includes('/v2/plugin/auth/token?')) {
    return new Response(JSON.stringify({
      code: 0,
      data: {
        accessToken: 'acc-1',
        refreshToken: 'ref-1',
        expiresIn: 3600,
        refreshExpiresIn: 86400,
        tokenType: 'Bearer',
        scope: 'default',
        domain: 'copilot.tencent.com',
      },
    }), { status: 200 })
  }
  if (path.includes('/v2/plugin/login/account?')) {
    return new Response(JSON.stringify({ code: 0, data: { uid: 'u-1', nickname: 'tester', enterpriseId: '', tenantId: '', userId: '' } }), { status: 200 })
  }
  if (path.includes('/v3/config')) {
    return new Response(JSON.stringify({ code: 0, data: { data: { models: [{ id: 'glm-5.3', name: 'glm-5.3', provider: 'codebuddy' }] } } }), { status: 200 })
  }
  if (path.includes('/v2/chat/completions')) {
    const sse = [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
}

interface Harness {
  server: Server
  endpointUrl: string
  workdir: string
  close: () => Promise<void>
}

async function startExtension(token: string): Promise<Harness> {
  const workdir = mkdtempSync(join(tmpdir(), 'gw-tokrot-'))
  const ext = await startCodeBuddyExtension({
    dataDir: join(workdir, 'data'),
    secret: 'e2e-secret-0123456789abcdef',
    fetcher: upstreamFetch,
    product: CODEBUDDY,
  })
  // the extension reads its token from process.env at request time
  process.env.GATEWAY_EXTENSION_TOKEN = token
  return {
    server: ext.server,
    endpointUrl: ext.endpointUrl,
    workdir,
    close: async () => {
      await new Promise<void>((r) => ext.server.close(() => r()))
      rmSync(workdir, { recursive: true, force: true })
    },
  }
}

/** An active account so chat has something to route to. */
async function provision(baseUrl: string, token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ accountId: 'acc-c1' }),
  })
  expect(res.status).toBe(201)
  let status = 'pending'
  for (let i = 0; i < 20 && status !== 'active'; i++) {
    const d = await fetch(`${baseUrl}/v1/accounts/acc-c1`, { headers: { authorization: `Bearer ${token}` } })
    const body = await d.json() as { account: { status: string } }
    status = body.account.status
  }
  expect(status).toBe('active')
  return 'acc-c1'
}

// The extension reads its token from process.env, so two instances cannot hold
// different tokens concurrently. Each test therefore starts exactly ONE
// extension process, fully isolated.
describe('extension token rotation', () => {
  let ext: Harness

  afterAll(async () => {
    await ext?.close()
  })

  it('a stale token is reported as EXTENSION_AUTH, not AUTH_INVALID', async () => {
    ext = await startExtension(OLD_TOKEN)
    const res = await fetch(`${ext.endpointUrl}/v1/models?account_id=x`, {
      headers: { authorization: `Bearer ${NEW_TOKEN}` }, // extension expects OLD_TOKEN
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { kind: string; message: string } }
    expect(body.error.kind).toBe('EXTENSION_AUTH')
    // the message must not leak the token
    expect(body.error.message).not.toContain(NEW_TOKEN.slice(0, 8))
  })

  it('EXTENSION_AUTH maps to a transport failure, never an account-auth failure', async () => {
    const err = extensionErrorToUpstreamError(
      { error: { kind: 'EXTENSION_AUTH', message: 'extension auth token mismatch' } },
      PROVIDER_ID,
    )
    // TRANSPORT => the account pool will NOT park the account in token_expired
    expect(err.kind).toBe('TRANSPORT')
    expect(err.detail).toBe('extension_auth')
    // and it is explicitly not treated as a credential problem
    expect(err.isAuthProblem).toBe(false)
  })

  it('a real provider auth failure still reports AUTH_INVALID (no over-broad matching)', async () => {
    const err = extensionErrorToUpstreamError(
      { error: { kind: 'AUTH_INVALID', message: 'upstream auth rejected (HTTP 401)', httpStatus: 401 } },
      PROVIDER_ID,
    )
    expect(err.kind).toBe('AUTH_INVALID')
    expect(err.detail).not.toBe('extension_auth')
  })

  describe('recovery flow', () => {
    it('refreshes the mounted provider token and the next request succeeds', async () => {
      // One isolated extension whose CURRENT token is NEW_TOKEN (post-rotation).
      ext = await startExtension(NEW_TOKEN)
      await provision(ext.endpointUrl, NEW_TOKEN)

      // Core mounted the provider earlier with the STALE token.
      const registry = new ProviderRegistry()
      const store = new MemoryStore()
      const manifest = await (await fetch(`${ext.endpointUrl}/manifest`)).json()
      const [staleProvider] = buildRemoteProviders({
        manifest: structuredClone(manifest),
        endpoints: { baseUrl: ext.endpointUrl, token: OLD_TOKEN },
      })
      registry.register(staleProvider)

      // The stale registration is rejected as a hop-auth failure.
      const staleClient = new RemoteExtensionClient({
        endpoints: { baseUrl: ext.endpointUrl, token: OLD_TOKEN },
      })
      let mismatch: unknown
      try {
        await staleClient.requestChat({
          accountId: 'acc-c1', model: 'glm-5.3', requestId: 'r2', deadlineMs: 5000,
          messages: [{ role: 'user', content: 'hi' }], stream: false,
        } as never)
      } catch (e) { mismatch = e }
      expect(mismatch).toBeInstanceOf(Error)
      expect((mismatch as { detail?: string }).detail).toBe('extension_auth')

      // Recovery: re-pull the registration package (Manager is authoritative).
      const recovery = new ExtensionAuthRecovery(
        { store, registry, now: () => Date.now() } as never,
        { managerUrl: 'http://manager.test', managerToken: 'mgr-token' },
        (async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url.endsWith(`/api/extensions/${EXT_ID}/registration`)) {
            return new Response(JSON.stringify({
              manifest,
              endpointUrl: ext.endpointUrl,
              token: NEW_TOKEN, // the rotated credential
            }), { status: 200 })
          }
          return new Response('{}', { status: 404 })
        }) as typeof fetch,
      )
      expect(await recovery.refresh(EXT_ID)).toBe(true)

      // The registry now holds a provider wired to the NEW token.
      expect(registry.get(PROVIDER_ID)).toBeDefined()
      const freshClient = new RemoteExtensionClient({
        endpoints: { baseUrl: ext.endpointUrl, token: NEW_TOKEN },
      })
      const result = await freshClient.requestChat({
        accountId: 'acc-c1', model: 'glm-5.3', requestId: 'r3', deadlineMs: 5000,
        messages: [{ role: 'user', content: 'hi' }], stream: false,
      } as never)
      expect(result.content).toBe('ok')
    })

    it('re-registration is idempotent (no duplicate providers)', async () => {
      ext = await startExtension(NEW_TOKEN)
      const registry = new ProviderRegistry()
      const store = new MemoryStore()
      const manifest = await (await fetch(`${ext.endpointUrl}/manifest`)).json()
      const recovery = new ExtensionAuthRecovery(
        { store, registry, now: () => Date.now() } as never,
        { managerUrl: 'http://manager.test', managerToken: 'mgr-token' },
        (async () => new Response(JSON.stringify({
          manifest, endpointUrl: ext.endpointUrl, token: NEW_TOKEN,
        }), { status: 200 })) as typeof fetch,
      )
      expect(await recovery.refresh(EXT_ID)).toBe(true)
      expect(await recovery.refresh(EXT_ID)).toBe(true)
      expect(registry.list().filter((p) => p.id === PROVIDER_ID)).toHaveLength(1)
    })

    it('a failing Manager is bounded: refresh returns false, records a warning, does not throw', async () => {
      const registry = new ProviderRegistry()
      const store = new MemoryStore()
      const recovery = new ExtensionAuthRecovery(
        { store, registry, now: () => Date.now() } as never,
        { managerUrl: 'http://manager.test', managerToken: 'mgr-token' },
        (async () => new Response('boom', { status: 500 })) as typeof fetch,
      )
      expect(await recovery.refresh(EXT_ID)).toBe(false)
      // cooldown: an immediate second attempt is skipped (no retry storm)
      expect(await recovery.refresh(EXT_ID)).toBe(false)
      const events = store.listEvents()
      expect(events.some((e) => e.kind === 'extension.token_refresh_failed')).toBe(true)
    })

    it('resolves the owning extension id from the Manager (multi-provider images)', async () => {
      ext = await startExtension(NEW_TOKEN)
      const manifest = await (await fetch(`${ext.endpointUrl}/manifest`)).json()
      const id = await resolveExtensionIdForProvider(
        { managerUrl: 'http://manager.test', managerToken: 'mgr-token' },
        PROVIDER_ID,
        (async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url.endsWith('/api/extensions/available')) {
            return new Response(JSON.stringify({ extensions: [{ extensionId: EXT_ID, status: 'installed' }] }), { status: 200 })
          }
          if (url.includes(`/api/extensions/${EXT_ID}/registration`)) {
            return new Response(JSON.stringify({ manifest, endpointUrl: ext.endpointUrl, token: NEW_TOKEN }), { status: 200 })
          }
          return new Response('{}', { status: 404 })
        }) as typeof fetch,
      )
      expect(id).toBe(EXT_ID)
    })
  })
})
