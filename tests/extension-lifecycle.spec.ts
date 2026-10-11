/**
 * M0 extension lifecycle tests (docs/EXTENSION_LIFECYCLE.md):
 *  - Manager: per-extension lock, 'stopped' status, providerIds persistence,
 *    upgrade (idempotent no-op, blue-green with volume retention, rollback).
 *  - Core ExtensionService: three-state projection, trusted-source policy,
 *    ManagerClient error mapping, ManagerClient transport behavior.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ExtensionManager,
  LocalProcessRuntime,
  ManagerStore,
  startManagerApi,
} from '../src/manager/index.js'
import { ExtensionService } from '../src/service/extension-service.js'
import { ManagerClient, ManagerClientError } from '../src/service/manager-client.js'
import { OpenAIApiError } from '../src/protocol/openai/parse.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import type { Server } from 'node:http'

const newStore = (): ManagerStore =>
  new ManagerStore(join(mkdtempSync(join(tmpdir(), 'gw-m0-')), 'manager.db'))

const FAKE_IMAGE = {
  repo: 'local/gateway-extension-fake',
  tag: '1.0.0',
  entryUrl: new URL('../src/extensions/fake/main.ts', import.meta.url).href,
}

interface LocalImageDescriptorEx {
  entryUrl: string
  env?: Record<string, string>
}

async function fakeManifest() {
  const { FAKE_MANIFEST } = await import('../src/extensions/fake/main.js')
  return structuredClone(FAKE_MANIFEST)
}

function makeManager(store: ManagerStore, healthTimeoutMs = 15_000): { manager: ExtensionManager; runtime: LocalProcessRuntime & { registerLocalImage: (repo: string, tag: string, d: LocalImageDescriptorEx) => { digest: string } } } {
  const runtime = new LocalProcessRuntime() as unknown as LocalProcessRuntime & { registerLocalImage: (repo: string, tag: string, d: LocalImageDescriptorEx) => { digest: string } }
  runtime.registerLocalImage(FAKE_IMAGE.repo, FAKE_IMAGE.tag, { entryUrl: FAKE_IMAGE.entryUrl })
  return { manager: new ExtensionManager({ store, runtime, healthTimeoutMs }), runtime }
}

// ---------------------------------------------------------------------------
// Manager: lock + stopped + providerIds
// ---------------------------------------------------------------------------

describe('manager m0: lock / stopped / providerIds', () => {
  it('serializes lifecycle verbs per extension (lock rejects concurrent mutation)', async () => {
    const s = newStore()
    const { manager } = makeManager(s)
    const manifest = await fakeManifest()
    await manager.install({ kind: 'manifest', manifest, image: { repo: FAKE_IMAGE.repo, tag: FAKE_IMAGE.tag } })

    // occupy the lock with a long-running stop via a runtime we control
    const rec = manager.get('fake')!
    expect(rec.providerIds).toEqual(['echo'])

    // upgrade while an install-shaped lock is held → busy error
    const release = (manager as unknown as { acquire: (id: string, verb: string) => () => void })
      .acquire('fake', 'test-verb')
    await expect(manager.stop('fake')).rejects.toThrow(/is busy: test-verb/)
    await expect(manager.upgrade('fake', { kind: 'manifest', manifest })).rejects.toThrow(/is busy/)
    release()

    // after release the verb works
    await manager.stop('fake')
    expect(manager.get('fake')!.status).toBe('stopped')
    // restart brings it back to installed
    await manager.restart('fake')
    expect(manager.get('fake')!.status).toBe('installed')
    await manager.remove('fake')
    s.close()
  })

  it('stop → restart preserves the record and manifest stash', async () => {
    const s = newStore()
    const { manager } = makeManager(s)
    const manifest = await fakeManifest()
    await manager.install({ kind: 'manifest', manifest, image: { repo: FAKE_IMAGE.repo, tag: FAKE_IMAGE.tag } })
    await manager.stop('fake')
    await manager.restart('fake')
    const rec = manager.get('fake')!
    expect(rec.status).toBe('installed')
    expect(rec.error).toBeNull()
    await manager.remove('fake')
    s.close()
  })
})

// ---------------------------------------------------------------------------
// Manager: upgrade semantics (D4)
// ---------------------------------------------------------------------------

describe('manager m0: upgrade', () => {
  it('same version without image override is an idempotent no-op', async () => {
    const s = newStore()
    const { manager } = makeManager(s)
    const manifest = await fakeManifest()
    await manager.install({ kind: 'manifest', manifest, image: { repo: FAKE_IMAGE.repo, tag: FAKE_IMAGE.tag } })
    const before = manager.get('fake')!
    const result = await manager.upgrade('fake', { kind: 'manifest', manifest })
    expect(result.status).toBe('installed')
    const after = manager.get('fake')!
    expect(after.containerId).toBe(before.containerId) // same container, untouched
    await manager.remove('fake')
    s.close()
  })

  it('upgrades to a new version blue-green and keeps installedAt', async () => {
    const s = newStore()
    const { manager, runtime } = makeManager(s)
    const manifest = await fakeManifest()
    await manager.install({ kind: 'manifest', manifest, image: { repo: FAKE_IMAGE.repo, tag: FAKE_IMAGE.tag } })
    const before = manager.get('fake')!
    // the fake extension serves the manifest version from GW_FAKE_MANIFEST_VERSION
    runtime.registerLocalImage(FAKE_IMAGE.repo, '1.0.1', {
      entryUrl: FAKE_IMAGE.entryUrl,
      env: { GW_FAKE_MANIFEST_VERSION: '1.0.1' },
    } as never)

    const v2 = await fakeManifest()
    v2.extension.version = '1.0.1'
    const result = await manager.upgrade('fake', {
      kind: 'manifest', manifest: v2, image: { repo: FAKE_IMAGE.repo, tag: '1.0.1' },
    })
    expect(result.status).toBe('installed')
    const after = manager.get('fake')!
    expect(after.version).toBe('1.0.1')
    // local runtime reuses the deterministic container name; the blue-green
    // swap is observable in the endpoint port and fresh token fingerprint
    expect(after.endpointUrl).not.toBe(before.endpointUrl)
    expect(after.tokenFingerprint).not.toBe(before.tokenFingerprint)
    expect(after.installedAt).toBe(before.installedAt) // history preserved
    await manager.remove('fake')
    s.close()
  })

  it('rolls back to the previous version when the new one fails health', async () => {
    const s = newStore()
    const { manager, runtime } = makeManager(s)
    const manifest = await fakeManifest()
    await manager.install({ kind: 'manifest', manifest, image: { repo: FAKE_IMAGE.repo, tag: FAKE_IMAGE.tag } })
    const before = manager.get('fake')!

    // new "version" whose entry is a plain HTTP server that never serves the
    // protocol → pull succeeds, health/handshake fails → rollback window
    runtime.registerLocalImage(FAKE_IMAGE.repo, '9.9.9', {
      entryUrl: new URL('./helpers/never-healthy.ts', import.meta.url).href,
    })
    const bad = await fakeManifest()
    bad.extension.version = '9.9.9'
    await expect(manager.upgrade('fake', {
      kind: 'manifest', manifest: bad, image: { repo: FAKE_IMAGE.repo, tag: '9.9.9' },
    })).rejects.toThrow(/upgrade failed/)

    const rec2 = manager.get('fake')!
    expect(rec2.version).toBe(before.version) // rolled back
    expect(rec2.status).toBe('installed')
    expect(rec2.error).toMatch(/upgrade rolled back/)
    expect(rec2.containerId).toBeTruthy() // a container serves again
    await manager.remove('fake')
    s.close()
  })

  it('refuses upgrades with a mismatched manifest id', async () => {
    const s = newStore()
    const { manager } = makeManager(s)
    const manifest = await fakeManifest()
    await manager.install({ kind: 'manifest', manifest, image: { repo: FAKE_IMAGE.repo, tag: FAKE_IMAGE.tag } })
    const other = await fakeManifest()
    other.extension.id = 'other'
    await expect(manager.upgrade('fake', { kind: 'manifest', manifest: other })).rejects.toThrow(/does not match/)
    await manager.remove('fake')
    s.close()
  })
})

// ---------------------------------------------------------------------------
// Manager HTTP: upgrade route
// ---------------------------------------------------------------------------

describe('manager m0: HTTP upgrade route', () => {
  let server: Server
  let url: string
  let manager: ExtensionManager
  let s: ManagerStore

  beforeEach(async () => {
    s = newStore()
    const runtime = new LocalProcessRuntime()
    runtime.registerLocalImage(FAKE_IMAGE.repo, FAKE_IMAGE.tag, { entryUrl: FAKE_IMAGE.entryUrl })
    manager = new ExtensionManager({ store: s, runtime, healthTimeoutMs: 15_000 })
    server = await startManagerApi({ manager, token: 'mgr-secret-token' })
    const addr = server.address()
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })
  afterEach(async () => {
    server.close()
    s.close()
  })

  it('upgrades through the API with auth; rejects bad bodies', async () => {
    const manifest = await fakeManifest()
    await manager.install({ kind: 'manifest', manifest, image: { repo: FAKE_IMAGE.repo, tag: FAKE_IMAGE.tag } })
    const res = await fetch(`${url}/api/extensions/fake/upgrade`, {
      method: 'POST',
      headers: { authorization: 'Bearer mgr-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
    })
    expect(res.status).toBe(200) // idempotent same-version no-op
    const noBody = await fetch(`${url}/api/extensions/fake/upgrade`, {
      method: 'POST',
      headers: { authorization: 'Bearer mgr-secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(noBody.status).toBe(400)
    const noAuth = await fetch(`${url}/api/extensions/fake/upgrade`, { method: 'POST', body: '{}' })
    expect(noAuth.status).toBe(401)
    await manager.remove('fake')
  })
})

// ---------------------------------------------------------------------------
// ManagerClient: transport mapping (fake fetch)
// ---------------------------------------------------------------------------

describe('manager client m0', () => {
  const ok = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('maps transport failure to manager_unavailable and retries GETs once', async () => {
    let calls = 0
    const client = new ManagerClient({
      managerUrl: 'http://manager.internal',
      managerToken: 't',
      fetchImpl: async () => {
        calls++
        throw new Error('ECONNREFUSED')
      },
    })
    await expect(client.list()).rejects.toMatchObject({ code: 'manager_unavailable' })
    expect(calls).toBe(2) // one retry for idempotent GET
  })

  it('never retries POSTs', async () => {
    let calls = 0
    const client = new ManagerClient({
      managerUrl: 'http://manager.internal',
      managerToken: 't',
      fetchImpl: async () => {
        calls++
        throw new Error('ECONNREFUSED')
      },
    })
    await expect(client.stop('x')).rejects.toBeInstanceOf(ManagerClientError)
    expect(calls).toBe(1)
  })

  it('maps manager status codes to stable error codes', async () => {
    const client = new ManagerClient({
      managerUrl: 'http://manager.internal',
      managerToken: 't',
      fetchImpl: async (_url, init) => {
        const path = String(init?.method) === 'GET' ? new URL(String(_url)).pathname : ''
        if (path.endsWith('/unknown')) return ok({ error: 'unknown extension "unknown"' }, 404)
        if (path === '/api/extensions') return ok({ extensions: [] }, 401)
        return ok({ error: 'extension "x" is busy: install in progress' }, 400)
      },
    })
    await expect(client.get('unknown')).rejects.toMatchObject({ code: 'extension_not_found', status: 404 })
    await expect(client.list()).rejects.toMatchObject({ code: 'manager_auth_misconfigured' })
    // busy message from a 400 becomes 409 operation_in_progress at the service layer
  })

  it('sends the bearer token and never echoes it in errors', async () => {
    let seenAuth: string | undefined
    const client = new ManagerClient({
      managerUrl: 'http://manager.internal',
      managerToken: 'super-secret-token',
      fetchImpl: async (_url, init) => {
        seenAuth = new Headers(init?.headers).get('authorization')
        return ok({ error: 'boom with no token' }, 500)
      },
    })
    await expect(client.list()).rejects.toThrow(/boom with no token/)
    expect(seenAuth).toBe('Bearer super-secret-token')
    try {
      await client.list()
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-token')
    }
  })
})

// ---------------------------------------------------------------------------
// ExtensionService: projection + policy (fake ManagerClient via fake fetch)
// ---------------------------------------------------------------------------

function serviceWith(fetchImpl: typeof fetch, registry = new ProviderRegistry()): ExtensionService {
  return new ExtensionService({
    endpoint: { managerUrl: 'http://manager.internal', managerToken: 't' },
    ctx: () => ({ store: {} as never, registry }),
    fetchImpl,
  })
}

const rec = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  extensionId: 'fake', version: '1.0.0', imageRepo: 'local/gateway-extension-fake',
  imageTag: '1.0.0', imageDigest: null, endpointUrl: 'http://gw-ext-fake:8080',
  status: 'installed', providerIds: ['echo'], error: null,
  installedAt: 1, updatedAt: 2, ...over,
})

describe('extension service m0', () => {
  it('projects three states: running/healthy/registered', async () => {
    const svc = serviceWith(async (_url, init) => {
      if (String(new URL(String(_url)).pathname) === '/health') {
        return ok({ status: 'healthy' })
      }
      return ok({ extensions: [rec()] })
    })
    const list = await svc.list()
    expect(list[0]).toMatchObject({
      installState: 'installed', runtimeState: 'running', healthState: 'healthy',
      providers: ['echo'], providersRegistered: false, // registry empty in this test
    })
  })

  it('stopped install state → runtime stopped without probing', async () => {
    const healthCalls: string[] = []
    const svc = serviceWith(async (url) => {
      const path = new URL(String(url)).pathname
      if (path === '/health') { healthCalls.push(path); return ok({ status: 'healthy' }) }
      if (path === '/api/extensions/fake') return ok(rec({ status: 'stopped' }))
      return ok({ extensions: [rec({ status: 'stopped' })] })
    })
    const view = await svc.detail('fake')
    expect(view).toMatchObject({ installState: 'stopped', runtimeState: 'stopped', healthState: 'unknown' })
    expect(healthCalls).toEqual([]) // never probed a stopped extension
  })

  it('maps manager transport failure on projections to 503 manager_unavailable', async () => {
    const svc = serviceWith(async () => { throw new Error('boom') })
    await expect(svc.detail('fake')).rejects.toSatisfy(isOpenAI(503, 'manager_unavailable'))
  })

  it('enforces trusted image source policy', async () => {
    const svc = serviceWith(async () => ok({ extensions: [] }))
    const manifest = { extension: { id: 'fake', version: '1.0.0' } }
    await expect(svc.install({ manifest, image: { repo: 'evil/registry', tag: '1.0.0' } }))
      .rejects.toSatisfy(isOpenAI(400, 'forbidden_image_source'))
    await expect(svc.install({ manifest, image: { repo: 'local/gateway-extension-fake', tag: '9.9.9' } }))
      .rejects.toSatisfy(isOpenAI(400, 'forbidden_image_source'))
    // tag mismatch with manifest version → rejected
    await expect(svc.upgrade('fake', {
      manifest: { extension: { id: 'fake', version: '1.0.0' } },
      image: { repo: 'local/gateway-extension-fake', tag: '9.9.9' },
    })).rejects.toSatisfy(isOpenAI(400, 'forbidden_image_source'))
    // path/manifest id mismatch → rejected
    await expect(svc.upgrade('other', {
      manifest: { extension: { id: 'fake', version: '1.0.0' } },
    })).rejects.toSatisfy((e: unknown) => e instanceof OpenAIApiError && (e as OpenAIApiError).status === 400)
  })

  it('maps busy manager errors to 409 operation_in_progress', async () => {
    const svc = serviceWith(async (_url, init) => {
      if (String(init?.method) === 'POST') return ok({ error: 'extension "fake" is busy: install in progress' }, 400)
      return ok({ extensions: [rec()] })
    })
    await expect(svc.stop('fake')).rejects.toSatisfy(isOpenAI(409, 'operation_in_progress'))
  })

  function isOpenAI(status: number, code: string): (e: unknown) => boolean {
    return (e: unknown) => e instanceof OpenAIApiError
      && (e as OpenAIApiError).status === status
      && (e as OpenAIApiError).code === code
  }

  it('rejects malformed extension ids and manifests', async () => {
    const svc = serviceWith(async () => ok({ extensions: [] }))
    await expect(svc.stop('../etc')).rejects.toBeInstanceOf(OpenAIApiError)
    await expect(svc.install({ manifest: { nope: true } })).rejects.toMatchObject({ status: 400 })
    await expect(svc.install({})).rejects.toMatchObject({ status: 400 })
  })

  it('reload refuses non-installed extensions without touching bootstrap', async () => {
    const svc = serviceWith(async (_url, init) => {
      const path = new URL(String(_url)).pathname
      if (path === '/api/extensions/fake') return ok(rec({ status: 'failed' }))
      throw new Error('should not reach registration')
    })
    await expect(svc.reload('fake')).rejects.toMatchObject({ status: 409 })
  })
})

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
