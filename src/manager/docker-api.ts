/**
 * Docker Engine API runtime backend.
 *
 * The only component in the entire system that talks to the Docker daemon,
 * and even here ONLY through the fixed lifecycle verbs of ContainerRuntime —
 * there is no generic passthrough: every request body is built from a
 * SanitizedContainerSpec produced by policy.ts (deny-by-default).
 *
 * Hardcoded request properties (asserted in tests):
 *   - Privileged: false, CapDrop: ["ALL"], NoNewPrivileges: true
 *   - ReadonlyRootfs: true, Tmpfs {"/tmp": "rw,size=64m"}
 *   - HostConfig.PortBindings: {} (no published ports)
 *   - Binds: never populated from host paths (named volumes only)
 *   - NetworkMode: the single manager-internal network
 *
 * Phase 2 ships this backend complete but it only activates where a daemon
 * exists (homeserver deployment, CI with docker). Tests run the identical
 * manager flow over LocalProcessRuntime.
 */

import { request as httpRequest } from 'node:http'
import type { ContainerHandle, ContainerRuntime, ImageRef, SanitizedContainerSpec } from './runtime.js'

/**
 * fetch over the Docker unix socket (node:http socketPath). Returned Response
 * bodies are buffered — Docker lifecycle payloads are small JSON documents.
 */
function dockerSocketFetch(socketPath: string): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const res = await new Promise<{ status: number; headers: Record<string, string>; text: string }>((resolve, reject) => {
      const req = httpRequest({
        socketPath,
        method: init.method ?? 'GET',
        path: url.pathname + url.search,
        headers: (init.headers as Record<string, string> | undefined) ?? {},
      }, (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(r.headers)) {
            if (typeof v === 'string') headers[k] = v
            else if (Array.isArray(v)) headers[k] = v.join(', ')
          }
          resolve({ status: r.statusCode ?? 0, headers, text: Buffer.concat(chunks).toString('utf8') })
        })
        r.on('error', reject)
      })
      if (init.body !== undefined) req.write(init.body)
      req.end()
      req.on('error', reject)
    })
    return new Response(res.status === 204 ? null : res.text, { status: res.status, headers: res.headers })
  }) as typeof fetch
}

export interface DockerRuntimeOptions {
  /** unix socket path; never a TCP endpoint in v1 */
  socketPath?: string
  apiVersion?: string
  fetchImpl?: typeof fetch
}

const DEFAULT_SOCKET = '/var/run/docker.sock'

export class DockerRuntime implements ContainerRuntime {
  private readonly socketPath: string
  private readonly apiVersion: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: DockerRuntimeOptions = {}) {
    this.socketPath = opts.socketPath ?? DEFAULT_SOCKET
    this.apiVersion = opts.apiVersion ?? 'v1.45'
    this.fetchImpl = opts.fetchImpl ?? dockerSocketFetch(this.socketPath)
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `http://localhost/${this.apiVersion}${path}`
    const res = await this.fetchImpl(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    } as RequestInit)
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`docker api ${method} ${path} -> ${res.status}: ${detail.slice(0, 200)}`)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  async pullImage(image: ImageRef): Promise<{ digest: string }> {
    const ref = `${image.repo}:${image.tag}`
    // local-image path first (dev/homeserver builds never touch a registry)
    const local = await this.localImageInspect(ref)
    if (local) {
      if (image.digest && image.digest !== local.digest) {
        throw new Error(`digest mismatch for ${ref}: pinned ${image.digest} != local ${local.digest}`)
      }
      return { digest: local.digest }
    }
    // distribution manifest → immutable digest (registry v2 API via docker)
    const res = await this.fetchImpl(`http://localhost/${this.apiVersion}/distribution/${encodeURIComponent(ref)}/json`)
    if (!res.ok) throw new Error(`cannot resolve digest for ${ref}: ${res.status}`)
    const info = await res.json() as { descriptor?: { digest?: string } }
    const digest = info.descriptor?.digest
    if (!digest) throw new Error(`registry returned no digest for ${ref}`)
    if (image.digest && image.digest !== digest) {
      throw new Error(`digest mismatch for ${ref}: pinned ${image.digest} != registry ${digest}`)
    }
    await this.api('POST', `/images/create?fromImage=${encodeURIComponent(image.repo)}&tag=${encodeURIComponent(image.tag)}`)
    return { digest }
  }

  /** GET /images/:ref/json → { digest: image id } when the image exists locally. */
  private async localImageInspect(ref: string): Promise<{ digest: string } | undefined> {
    const res = await this.fetchImpl(`http://localhost/${this.apiVersion}/images/${encodeURIComponent(ref)}/json`)
    if (!res.ok) return undefined
    const info = await res.json() as { Id?: string }
    const id = info.Id?.replace(/^sha256:/, '')
    if (!id) return undefined
    return { digest: `sha256:${id}` }
  }

  async createContainer(spec: SanitizedContainerSpec): Promise<ContainerHandle> {
    if (spec.capDrop !== 'ALL' || spec.privileged !== false || spec.readonlyRootfs !== true) {
      // belt & braces: the runtime itself refuses non-hardened specs
      throw new Error('refusing to create a container from a non-hardened spec')
    }
    const body = {
      Image: `${spec.image.repo}:${spec.image.tag}`,
      // manager-controlled name; no caller influence
      name: spec.name,
      Labels: spec.labels,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      ExposedPorts: { [`${spec.port}/tcp`]: {} },
      HostConfig: {
        // ── security invariants (never derived from manifest) ──
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,size=64m' },
        // NO PortBindings: extension ports stay inside the network
        PortBindings: {},
        // named volumes only; host binds cannot be expressed via this path
        Binds: spec.volumes.map((v) => `${v.name}:${v.mountPath}`),
        NetworkMode: spec.network,
        RestartPolicy: { Name: spec.restartPolicy },
        Memory: spec.memoryBytes,
        NanoCpus: spec.nanoCpus,
      },
    }
    const created = await this.api<{ Id: string }>('POST', `/containers/create?name=${encodeURIComponent(spec.name)}`, body)
    // endpoint: docker DNS name on the shared internal network
    return { containerId: created.Id, endpointUrl: `http://${spec.name}:${spec.port}` }
  }

  async start(containerId: string): Promise<void> {
    await this.api('POST', `/containers/${containerId}/start`)
  }

  async stop(containerId: string, timeoutMs = 10_000): Promise<void> {
    const res = await this.apiRaw('POST', `/containers/${containerId}/stop?t=${Math.ceil(timeoutMs / 1000)}`)
    // 404 = already gone — removal stays idempotent (docker rm -f semantics)
    if (res.status === 404) return
    if (res.status >= 400) throw new Error(`docker stop ${containerId} -> ${res.status}: ${res.text.slice(0, 200)}`)
  }

  async remove(containerId: string): Promise<void> {
    const res = await this.apiRaw('DELETE', `/containers/${containerId}?force=true&v=true`)
    if (res.status === 404) return
    if (res.status >= 400) throw new Error(`docker remove ${containerId} -> ${res.status}: ${res.text.slice(0, 200)}`)
  }

  /** Non-throwing variant for verbs that branch on status (e.g. idempotent 404). */
  private async apiRaw(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const url = `http://localhost/${this.apiVersion}${path}`
    const res = await this.fetchImpl(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    } as RequestInit)
    const text = await res.text().catch(() => '')
    return { status: res.status, text }
  }
}
