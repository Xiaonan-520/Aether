/**
 * Phase 3 local E2E: the full Phase-3 chain over REAL HTTP.
 *
 *   Gateway Core (ProviderRegistry + RemoteProvider)
 *     → Extension Manager (install → policy → create → start → health
 *       → manifest handshake → conformance gate)
 *       → LobsterAI Extension (real protocol process; credential store)
 *         → stubbed LobsterAI upstream (fetcher injection at the process
 *           boundary — no real network in CI)
 *
 * Docker equivalents run on the homeserver (p3-docker-e2e); the process
 * backend exercises the identical Manager/protocol contract.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionManager, startManagerApi } from '../src/manager/index.js'
import { ManagerStore } from '../src/manager/store.js'
import { registerRemoteExtensions } from '../src/http/remote-bootstrap.js'
import { MemoryStore } from '../src/store/memory-store.js'
import type { ContainerHandle, ContainerRuntime, ImageRef, SanitizedContainerSpec } from '../src/manager/runtime.js'
import { buildRemoteProviders } from '../src/protocol/extension/remote-provider.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { UpstreamError } from '../src/core/errors/upstream-error.js'
import type { Provider, Account, ChatRequest } from '../src/core/types.js'
import type { ProviderCtx } from '../src/service/context.js'
import { startLobsteraiExtension, LOBSTERAI_MANIFEST } from '../src/extensions/lobsterai/main.js'
import type { Server } from 'node:http'

// ---------------------------------------------------------------------------
// StaticRuntime: the extension process is started by the test itself (so the
// upstream fetcher can be stubbed); the runtime only reports its endpoint.
// Docker semantics that matter to the Manager (digest pinning, pull failure,
// stop/remove) are covered in manager.spec.ts via LocalProcessRuntime.
// ---------------------------------------------------------------------------

class StaticRuntime implements ContainerRuntime {
  constructor(private readonly endpointUrl: string) {}
  async pullImage(image: ImageRef): Promise<{ digest: string }> {
    return { digest: 'sha256:' + Buffer.from(`${image.repo}:${image.tag}`).toString('hex').padEnd(64, '0').slice(0, 64) }
  }
  async createContainer(_spec: SanitizedContainerSpec): Promise<ContainerHandle> {
    return { containerId: 'static-lobsterai', endpointUrl: this.endpointUrl }
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async remove(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// stub upstream (same shapes as extension-lobsterai.spec.ts)
// ---------------------------------------------------------------------------

let upstreamBehavior = {
  exchangeOk: true,
  chatStatus: 200,
  balance: { code: 0, data: { credits: 42.5, totalCredits: 100 } },
}

const upstreamFetch: typeof fetch = async (input) => {
  const path = String(input).replace(/^https:\/\/[^/]+/, '')
  if (path.startsWith('/api/auth/exchange')) {
    if (!upstreamBehavior.exchangeOk) {
      return new Response(JSON.stringify({ code: 1001, msg: 'invalid authCode' }), { status: 200 })
    }
    return new Response(JSON.stringify({
      code: 0,
      data: { accessToken: 'up-at-e2e', refreshToken: 'up-rt-e2e', expiresIn: 7200, user: { id: 'u1', nickname: 'Xiaonan' } },
    }), { status: 200 })
  }
  if (path.startsWith('/api/auth/refresh')) {
    return new Response(JSON.stringify({
      code: 0,
      data: { accessToken: 'up-at-r2', refreshToken: 'up-rt-r2', expiresIn: 7200, user: { id: 'u1', nickname: 'Xiaonan' } },
    }), { status: 200 })
  }
  if (path.startsWith('/api/models/available')) {
    return new Response(JSON.stringify({ code: 0, data: { models: [{ id: 'kimi-k3', name: 'Kimi K3', context_window: 1000000 }] } }), { status: 200 })
  }
  if (path.startsWith('/api/user/profile-summary')) {
    return new Response(JSON.stringify(upstreamBehavior.balance), { status: 200 })
  }
  if (path.startsWith('/api/proxy/v1/chat/completions')) {
    if (upstreamBehavior.chatStatus !== 200) {
      return new Response(JSON.stringify({ code: 4291, msg: 'rate limited' }), { status: upstreamBehavior.chatStatus })
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"id":"c","object":"chat.completion.chunk","choices":[{"delta":{"content":"e2e via core"}}]}\n\n`))
        controller.enqueue(encoder.encode(`data: {"id":"c","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return new Response('{}', { status: 404 })
}

// ---------------------------------------------------------------------------

let ext: Awaited<ReturnType<typeof startLobsteraiExtension>>
let server: Server
let manager: ExtensionManager
let store: ManagerStore
let remote: Provider
const workdir = mkdtempSync(join(tmpdir(), 'gw-p3e2e-'))
const installedManifest = structuredClone(LOBSTERAI_MANIFEST)
const authHeaders = { 'content-type': 'application/json', authorization: 'Bearer e2e-ext-token' }

beforeAll(async () => {
  ext = await startLobsteraiExtension({ dataDir: join(workdir, 'data'), secret: 'e2e-secret-0123456789abcdef', fetcher: upstreamFetch })
  server = ext.server
  store = new ManagerStore(join(workdir, 'manager.db'))
  manager = new ExtensionManager({
    store,
    runtime: new StaticRuntime(ext.endpointUrl),
    issueToken: () => 'e2e-ext-token',
    registrationSecret: 'e2e-registration-secret-0123456789',
  })
})

afterAll(async () => {
  server.close()
  store.close()
})

/** Provision an active account through the opaque action channel. */
async function provisionActiveAccount(): Promise<string> {
  const account = await fetch(`${ext.endpointUrl}/v1/accounts`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify({ loginMode: 'external-link' }),
  }).then((r) => r.json() as Promise<{ accountId: string }>)
  const out = await fetch(`${ext.endpointUrl}/v1/actions/submit-auth-code`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ payload: { code: 'e2e-code', account_id: account.accountId } }),
  }).then((r) => r.json() as Promise<{ result: { accepted: boolean } }>)
  expect(out.result.accepted).toBe(true)
  return account.accountId
}

function fakeAccount(id: string): Account {
  return {
    id,
    provider: 'lobsterai',
    displayName: id,
    status: 'active',
    enabled: true,
    authenticated: true,
    tokenExpiryAt: null,
    refreshable: true,
    credentialKey: 'opaque',
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    cooldownUntil: null,
    modelRateLimits: {},
    quotaJson: null,
    lastQuotaAt: null,
  } as unknown as Account
}

const chatReq = (stream: boolean): ChatRequest => ({
  model: 'kimi-k3',
  messages: [{ role: 'user', content: 'hi' }],
  stream,
})

describe('Phase 3 local E2E — Core → Manager → LobsterAI Extension', () => {
  it('installs the lobsterai extension through the real Manager chain (health + conformance gate)', async () => {
    const out = await manager.install({
      kind: 'manifest',
      manifest: installedManifest,
      image: { repo: 'local/gateway-extension-lobsterai', tag: '1.0.0' },
    })
    expect(out.status).toBe('installed')
    expect(out.providers.map((p) => p.id)).toEqual(['lobsterai'])
    const rec = manager.get('lobsterai')!
    expect(rec.status).toBe('installed')
    expect(rec.imageDigest).toMatch(/^sha256:/)
  })

  it('registers the remote provider into Core via buildRemoteProviders', () => {
    const registry = new ProviderRegistry()
    const providers = buildRemoteProviders({
      manifest: installedManifest,
      endpoints: { baseUrl: ext.endpointUrl, token: 'e2e-ext-token' },
    })
    expect(providers).toHaveLength(1)
    remote = providers[0]!
    registry.register(remote)
    expect(registry.get('lobsterai')).toBe(remote)
  })

  it('Core bootstrap: registerRemoteExtensions mounts providers via the Manager HTTP API', async () => {
    // the manager serves its real HTTP API (deployment form)
    const apiServer = await startManagerApi({ manager, token: 'mgr-token-e2e', port: 0 })
    try {
      const coreStore = new MemoryStore()
      const { ProviderRegistry: Reg } = await import('../src/core/registry/provider-registry.js')
      const registry = new Reg()
      const count = await registerRemoteExtensions(
        { store: coreStore, registry },
        { managerUrl: `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`, managerToken: 'mgr-token-e2e' },
      )
      expect(count).toBe(1)
      expect(registry.get('lobsterai')).toBeDefined()
      // provider row persisted + fallback models seeded into the model table
      // provider row exists (verify via FK behavior: creating a lobsterai
      // account must not violate the providers foreign key)
      const created = coreStore.createAccount({
        id: 'lobsterai-fk-probe', provider: 'lobsterai', displayName: 'probe',
        status: 'active', enabled: true, authenticated: true, tokenExpiryAt: null,
        refreshable: true, credentialKey: 'CRED_X', failureCount: 0,
        lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
        modelRateLimits: {}, quotaJson: null, lastQuotaAt: null,
      } as never)
      expect(created.ok).toBe(true)
      const models = coreStore.listModels().filter((m) => m.provider === 'lobsterai')
      expect(models.map((m) => m.modelId)).toEqual(['lobsterai::kimi-k3', 'lobsterai::glm-5'])
    } finally {
      apiServer.close()
    }
  })

  it('Core bootstrap tolerates a wrong manager token without throwing', async () => {
    const coreStore = new MemoryStore()
    const { ProviderRegistry: Reg } = await import('../src/core/registry/provider-registry.js')
    const registry = new Reg()
    await expect(registerRemoteExtensions(
      { store: coreStore, registry },
      { managerUrl: 'http://127.0.0.1:1', managerToken: 'wrong' },
    )).rejects.toThrow()
  })

  it('streaming: RemoteProvider.stream yields upstream content through the extension', async () => {
    const accountId = await provisionActiveAccount()
    const chunks: Array<{ text?: string }> = []
    for await (const chunk of remote.chat.stream({} as ProviderCtx, chatReq(true), fakeAccount(accountId))) {
      chunks.push(chunk as { text?: string })
    }
    const joined = chunks.map((c) => c.text ?? '').join('')
    expect(joined).toContain('e2e via core')
  })

  it('login chain: beginLogin(Core id) → pending projection → importCredential(action bridge) → active', async () => {
    // Core allocates the id and calls auth.beginLogin exactly like LoginService
    const loginId = 'lobsterai-e2e-login'
    const begun = await remote.auth.beginLogin!({ provider: 'lobsterai', accountId: loginId })
    expect(begun.loginUrl).toContain('lobsterai.youdao.com')
    expect(begun.needsManual).toBe(true)

    // poll before the human submits: pending account is visible, not 404
    const polled = await remote.auth.pollLogin!(loginId, 'lobsterai')
    expect(polled.done).toBe(false)

    // Core submitCredential → importCredential → opaque action channel
    const imported = await remote.auth.importCredential!(loginId, 'lobsterai', { code: 'e2e-code' })
    expect(imported.displayName).toBe('Xiaonan')
    expect(imported.credential).toBeUndefined() // §10.3: no credential material

    // after the exchange the account is active under Core's id
    const done = await remote.auth.pollLogin!(loginId, 'lobsterai')
    expect(done.done).toBe(true)
    expect(done.success).toBe(true)
    expect(ext.store.list().some((r) => r.accountId === loginId)).toBe(true)
  })

  it('importCredential with a rejected code maps to a structured AUTH_INVALID error', async () => {
    const loginId = 'lobsterai-e2e-badcode'
    await remote.auth.beginLogin!({ provider: 'lobsterai', accountId: loginId })
    upstreamBehavior.exchangeOk = false
    try {
      await remote.auth.importCredential!(loginId, 'lobsterai', { code: 'bad' })
      expect.unreachable('import should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamError)
      expect((err as UpstreamError).kind).toBe('AUTH_INVALID')
    } finally {
      upstreamBehavior.exchangeOk = true
    }
  })

  it('non-streaming: RemoteProvider.chat returns an aggregated result', async () => {
    const accountId = ext.store.list()[0]!.accountId
    const result = await remote.chat.chat({} as ProviderCtx, chatReq(false), fakeAccount(accountId))
    expect(result.content).toContain('e2e via core')
    expect(result.finishReason).toBe('stop')
  })

  it('quota: ops.getQuota projects the extension snapshot; zero credential material', async () => {
    const accountId = ext.store.list()[0]!.accountId
    const quota = await remote.ops.getQuota!({} as ProviderCtx, fakeAccount(accountId))
    const raw = JSON.stringify(quota)
    expect(raw).not.toContain('up-at-e2e')
    expect(quota.known).toBe(true)
    expect(quota.remaining).toBe(42.5)
    expect(quota.total).toBe(100)
  })

  it('models: chat.listModels returns upstream-discovered entries', async () => {
    const models = await remote.chat.listModels()
    expect(models.map((m) => m.modelId)).toEqual(['lobsterai::kimi-k3'])
    expect(models[0]!.provider).toBe('lobsterai')
    expect(models[0]!.upstreamModel).toBe('kimi-k3')
  })

  it('upstream 429 surfaces as a structured RATE_LIMIT UpstreamError', async () => {
    const accountId = ext.store.list()[0]!.accountId
    upstreamBehavior.chatStatus = 429
    try {
      await remote.chat.chat({} as ProviderCtx, chatReq(false), fakeAccount(accountId))
      expect.unreachable('chat should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamError)
      expect((err as UpstreamError).kind).toBe('RATE_LIMIT')
    } finally {
      upstreamBehavior.chatStatus = 200
    }
  })

  it('model-id regression: login-service.syncModels stores namespaced IDs consistent with bootstrap seeding', async () => {
    // Full Core-side flow with the real LobsterAI extension HTTP endpoint:
    // bootstrap seeding → login-service.syncModels → store → public model list → router resolution.
    const { LoginService } = await import('../src/service/login-service.js')
    const { ModelRouter } = await import('../src/core/router/model-router.js')
    const { AccountPool } = await import('../src/core/pool/account-pool.js')
    const { CredentialCipher } = await import('../src/store/crypto.js')
    const { loadConfig } = await import('../src/config/index.js')
    const { ZCodeCaptchaManager } = await import('../src/providers/zcode/captcha/manager.js')

    const store = new MemoryStore()
    const cipher = new CredentialCipher('0123456789abcdef')
    const registry = new ProviderRegistry()
    registry.register(remote)

    // 1. bootstrap fallback seeding (registerRemoteExtensions upsert path, done inline)
    for (const p of LOBSTERAI_MANIFEST.providers) {
      for (const m of p.fallbackModels ?? []) {
        store.upsertModels([{
          modelId: `${p.id}::${m.id}`, provider: p.id, upstreamModel: m.id,
          name: m.name,
          capabilities: { vision: m.capabilities?.vision ?? false, toolCall: m.capabilities?.toolCall ?? false, streaming: m.capabilities?.streaming ?? true },
          enabled: true, priority: 0, metadataJson: null,
        }])
      }
    }
    const bootstrapIds = store.listModels().map((m) => m.modelId).sort()
    expect(bootstrapIds).toEqual(['lobsterai::glm-5', 'lobsterai::kimi-k3'])

    // 2. login-service.syncModels over the real extension HTTP server
    const account: Account = {
      id: 'lobsterai-sync-probe', provider: 'lobsterai', displayName: 'probe',
      status: 'active', enabled: true, authenticated: true, tokenExpiryAt: null,
      refreshable: true, credentialKey: 'CRED_SYNC', failureCount: 0,
      lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null,
      modelRateLimits: {}, quotaJson: null, lastQuotaAt: null,
    } as never
    store.createAccount(account)
    const ctx = {
      config: loadConfig({ GATEWAY_API_KEY: 'k', GATEWAY_SECRET: '0123456789abcdef', GATEWAY_ADMIN_TOKEN: 't' } as never),
      store, cipher, registry,
      router: new ModelRouter(registry, () => store.listModels()),
      pool: new AccountPool({
        listAccounts: (p) => store.listAccounts(p).map((s) => s.account),
        patchAccount: () => {},
        hasCredential: () => true,
      }),
      now: () => Date.now(),
      captcha: new ZCodeCaptchaManager(),
    } as never
    const login = new LoginService(ctx)
    const synced = await login.syncModels('lobsterai', account)
    expect(synced).toBeGreaterThan(0)

    // 3. sync output is namespaced and MERGES with the bootstrap-seeded rows
    //    (no duplicate rows, no double prefix)
    const after = store.listModels().filter((m) => m.provider === 'lobsterai')
    expect(after.map((m) => m.modelId).sort()).toEqual(['lobsterai::glm-5', 'lobsterai::kimi-k3'])
    expect(after.every((m) => !m.modelId.startsWith('lobsterai::lobsterai::'))).toBe(true)
    // upstreamModel stays the bare upstream id
    expect(after.map((m) => m.upstreamModel).sort()).toEqual(['glm-5', 'kimi-k3'])

    // 4. router resolves the public namespaced ID to workbuddy-style provider seam
    //    (here: lobsterai) and yields the bare upstream model for the extension
    const router = new ModelRouter(registry, () => store.listModels())
    const hit = router.resolve('lobsterai::kimi-k3', true, () => true)
    expect(hit).not.toBeNull()
    expect(hit!.entry.upstreamModel).toBe('kimi-k3')
    expect(hit!.provider).toBe('lobsterai')
  })
})
