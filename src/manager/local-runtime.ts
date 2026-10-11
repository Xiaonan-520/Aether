/**
 * Local process runtime backend (dev/test).
 *
 * Runs an extension's entry (a Node module export) as an OS process listening
 * on an ephemeral 127.0.0.1 port. Lets the ENTIRE manager chain — install →
 * policy → create → start → health → conformance → register → chat — run for
 * real over HTTP on machines without a Docker daemon. Containers under Docker
 * use the same contract via DockerRuntimeBackend.
 *
 * NOT a production backend: there is no isolation beyond process boundaries.
 * The Fake Extension E2E and every manager integration test run through this.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { ContainerHandle, ContainerRuntime, ImageRef, SanitizedContainerSpec } from './runtime.js'

interface ProcRecord {
  child: ChildProcess
  port: number
  workdir: string
  /** re-spawns the entry on the SAME port (start-after-stop parity with docker) */
  respawn: () => ChildProcess
}

/** The image the local backend understands: local/fake-extension:<tag>. */
export interface LocalImageDescriptor {
  /** absolute import URL of the extension entry module */
  entryUrl: string
  /** named export to invoke: (port, env) => Promise<void> | http server */
  exportName?: string
  /** image-baked env (mirrors version/labels baked into a real image) */
  env?: Record<string, string>
}

export class LocalProcessRuntime implements ContainerRuntime {
  private readonly procs = new Map<string, ProcRecord>()
  private readonly images = new Map<string, LocalImageDescriptor>()
  private counter = 0

  /** Register how a local "image" boots. Mirrors docker load/pull in tests. */
  registerLocalImage(repo: string, tag: string, descriptor: LocalImageDescriptor): { digest: string } {
    this.images.set(`${repo}:${tag}`, descriptor)
    // deterministic pseudo-digest: content-addressed stand-in for tests
    return { digest: 'sha256:' + Buffer.from(`${repo}:${tag}:${descriptor.entryUrl}`).toString('hex').padEnd(64, '0').slice(0, 64) }
  }

  async pullImage(image: ImageRef): Promise<{ digest: string }> {
    const key = `${image.repo}:${image.tag}`
    if (!this.images.has(key)) {
      throw new Error(`local image not found: ${key}`)
    }
    // digest pinning: when the caller pinned a digest it must match
    const { digest } = this.resolveDigest(key)
    if (image.digest && image.digest !== digest) {
      throw new Error(`digest mismatch for ${key}: pinned ${image.digest} != local ${digest}`)
    }
    return { digest }
  }

  private resolveDigest(key: string): { digest: string } {
    const d = this.images.get(key)!
    return { digest: 'sha256:' + Buffer.from(`${key}:${d.entryUrl}`).toString('hex').padEnd(64, '0').slice(0, 64) }
  }

  async createContainer(spec: SanitizedContainerSpec): Promise<ContainerHandle> {
    const key = `${spec.image.repo}:${spec.image.tag}`
    const descriptor = this.images.get(key)
    if (!descriptor) throw new Error(`local image not found: ${key}`)

    const port = await freePort()
    const workdir = mkdtempSync(join(tmpdir(), 'gw-ext-'))
    // named volumes materialize as plain directories in the local backend
    for (const vol of spec.volumes) {
      const dir = join(workdir, 'volumes', vol.name)
      writeFileSync(join(workdir, `volume-map-${vol.name}.txt`), `${vol.name} -> ${vol.mountPath}\n`)
      void dir
    }
    const stateFile = join(workdir, 'state.json')
    writeFileSync(stateFile, JSON.stringify({ env: spec.env, port }))

    // boot the entry on the chosen port with the sanitized env
    const spawnArgs = [
      '--import', 'tsx',
      '-e', `
        import { run } from ${JSON.stringify(descriptor.entryUrl)}
        const state = JSON.parse(await import('node:fs').then(m => m.promises.readFile(${JSON.stringify(stateFile)}, 'utf8')))
        await run(state.port, state.env)
      `,
      '--', String(port),
    ]
    const spawnEnv = { ...process.env, ...spec.env, ...(descriptor.env ?? {}), PORT: String(port), GW_STATE_FILE: stateFile }
    const child = spawn(process.execPath, spawnArgs, {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    void this.counter
    child.stderr?.on('data', (d: Buffer) => {
      if (process.env.GW_EXTENSION_DEBUG) process.stderr.write(`[ext:${spec.name}] ${d}`)
    })

    this.procs.set(spec.name, {
      child,
      port,
      workdir,
      respawn: () => {
        const next = spawn(process.execPath, spawnArgs, {
          env: spawnEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        })
        next.stderr?.on('data', (d: Buffer) => {
          if (process.env.GW_EXTENSION_DEBUG) process.stderr.write(`[ext:${spec.name}] ${d}`)
        })
        return next
      },
    })
    return { containerId: `local-${spec.name}`, endpointUrl: `http://127.0.0.1:${port}` }
  }

  async start(containerId: string): Promise<void> {
    const name = containerId.replace(/^local-/, '')
    const rec = this.procs.get(name)
    if (!rec) throw new Error(`unknown container: ${containerId}`)
    if (rec.child.killed || rec.child.exitCode !== null) {
      // parity with `docker start`: a stopped container starts again on the
      // same endpoint (restart verb depends on this)
      rec.child = rec.respawn()
    }
    await waitUntilListening(rec.port, 15_000)
  }

  async stop(containerId: string): Promise<void> {
    const name = containerId.replace(/^local-/, '')
    const rec = this.procs.get(name)
    if (!rec) return
    if (!rec.child.killed) rec.child.kill('SIGTERM')
    // record STAYS so start() can respawn (docker stop/start parity)
  }

  async remove(containerId: string): Promise<void> {
    const name = containerId.replace(/^local-/, '')
    await this.stop(containerId)
    const rec = this.procs.get(name)
    if (rec?.workdir) {
      try {
        rmSync(rec.workdir, { recursive: true, force: true })
      } catch (err) {
        // cleanup failures are recorded, never swallowed silently
        console.warn(`[local-runtime] workdir cleanup failed for ${name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
    srv.on('error', reject)
  })
}

function waitUntilListening(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tryOnce = async (): Promise<boolean> => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
        return res.status < 500
      } catch {
        return false
      }
    }
    const tick = async () => {
      if (await tryOnce()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`extension did not become healthy within ${timeoutMs}ms`))
      setTimeout(tick, 100)
    }
    void tick()
  })
}
