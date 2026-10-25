/**
 * install-from-image (KI-001): the manager reads a manifest from the image
 * itself instead of requiring the caller to supply one.
 *
 * Uses the real ExtensionManager + LocalProcessRuntime + a real fake
 * extension process, so the probe container genuinely starts, serves
 * /manifest, and is removed. No Docker daemon needed.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ExtensionManager,
  LocalProcessRuntime,
  ManagerStore,
  startManagerApi,
} from '../src/manager/index.js'
import { FAKE_MANIFEST } from '../src/extensions/fake/main.js'
import type { Server } from 'node:http'

const image = { repo: 'local/gateway-extension-fake', tag: '1.0.0' }
const entryUrl = new URL('../src/extensions/fake/main.ts', import.meta.url).href

function makeManager(): { manager: ExtensionManager; runtime: LocalProcessRuntime } {
  const store = new ManagerStore(join(mkdtempSync(join(tmpdir(), 'gw-kI001-')), 'manager.db'))
  const runtime = new LocalProcessRuntime()
  runtime.registerLocalImage(image.repo, image.tag, { entryUrl })
  const manager = new ExtensionManager({ store, runtime, healthTimeoutMs: 15_000 })
  return { manager, runtime }
}

describe('ExtensionManager.inspectImage', () => {
  it('returns the manifest the image serves, without installing it', async () => {
    const { manager } = makeManager()
    const result = await manager.inspectImage(image)

    expect(result.manifest).toMatchObject({
      extension: { id: FAKE_MANIFEST.extension.id, version: FAKE_MANIFEST.extension.version },
    })
    expect(result.digest).toMatch(/^sha256:|^local:/)
    // nothing was persisted: an inspect is not an install
    expect(manager.list()).toHaveLength(0)
  })

  it('removes the probe container even when the image misbehaves', async () => {
    const { manager, runtime } = makeManager()
    // an image whose process exits immediately: the probe can never serve
    // /manifest, so the call must fail and still clean up
    runtime.registerLocalImage('local/broken', '1.0.0', { entryUrl: 'file:///nonexistent-entry.js' })
    await expect(manager.inspectImage({ repo: 'local/broken', tag: '1.0.0' })).rejects.toThrow()
    expect(manager.list()).toHaveLength(0)
  }, 45_000)

  it('refuses "latest" as a probe target', async () => {
    const { manager } = makeManager()
    await expect(manager.inspectImage({ repo: image.repo, tag: 'latest' })).rejects.toThrow(/latest/)
  })

  it('reports an unknown image instead of silently succeeding', async () => {
    const { manager } = makeManager()
    await expect(manager.inspectImage({ repo: 'local/does-not-exist', tag: '9.9.9' })).rejects.toThrow()
  })
})

describe('POST /api/extensions/inspect-image', () => {
  let api: Server | undefined
  let base = ''

  afterAll(() => {
    api?.close()
  })

  async function boot(): Promise<void> {
    const { manager } = makeManager()
    api = await startManagerApi({ manager, token: 'probe-token' })
    const addr = api.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    base = `http://127.0.0.1:${port}`
  }

  it('requires the manager token', async () => {
    await boot()
    const res = await fetch(`${base}/api/extensions/inspect-image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a body without an image reference', async () => {
    if (!base) await boot()
    const res = await fetch(`${base}/api/extensions/inspect-image`, {
      method: 'POST',
      headers: { authorization: 'Bearer probe-token', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns the manifest for an authenticated caller', async () => {
    if (!base) await boot()
    const res = await fetch(`${base}/api/extensions/inspect-image`, {
      method: 'POST',
      headers: { authorization: 'Bearer probe-token', 'content-type': 'application/json' },
      body: JSON.stringify({ image }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { manifest: { extension: { id: string } }; digest: string }
    expect(body.manifest.extension.id).toBe(FAKE_MANIFEST.extension.id)
    expect(typeof body.digest).toBe('string')
  })
})
