/**
 * Manager HTTP API (RFC v2 §17.1, §19.5).
 *
 * High-level lifecycle semantics ONLY with strong bearer auth — this surface
 * can never become a Docker passthrough: there is no endpoint that accepts
 * container specs, HostConfig, mounts, env maps or labels from callers.
 * Every handler maps 1:1 onto an ExtensionManager verb.
 *
 * Network position: manager-internal (never published). When embedded in the
 * gateway process for Phase 2 testing it binds to loopback only.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ExtensionManager } from './extension-manager.js'
import { sha256Hex } from './extension-manager.js'
import type { InstallSource } from './extension-manager.js'
import type { ExtensionManifest } from '../protocol/extension/manifest.js'

/** Manifests accepted by the Phase 2 install route. */
type ImportableManifest = Parameters<ExtensionManager['install']>[0] extends { kind: 'manifest'; manifest: infer M } ? M : ExtensionManifest

export interface ManagerApiOptions {
  manager: ExtensionManager
  /** strong shared token (manager API auth) */
  token: string
  /** loopback-only bind; manager must never be internet-facing */
  host?: string
  port?: number
}

export function startManagerApi(opts: ManagerApiOptions): Promise<Server> {
  const server = createServer((req, res) => {
    void handle(opts, req, res)
  })
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 0
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server))
  })
}

async function handle(opts: ManagerApiOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://manager.internal')
  const path = url.pathname

  // container healthcheck root — no token, no data, just liveness
  if (req.method === 'GET' && path === '/healthz') {
    send(res, 200, { ok: true })
    return
  }

  try {
    // ── auth: every route requires the manager token ────────────────────
    const auth = req.headers.authorization ?? ''
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    // constant-time compare
    if (presented.length !== opts.token.length || !timingSafeEqual(presented, opts.token)) {
      send(res, 401, { error: 'unauthorized' })
      return
    }

    // ── lifecycle routes (1:1 with manager verbs — nothing else exists) ──
    if (req.method === 'GET' && path === '/api/extensions') {
      send(res, 200, { extensions: opts.manager.list() })
      return
    }
    if (req.method === 'GET' && path === '/api/extensions/available') {
      send(res, 200, { extensions: await opts.manager.listRegisterable() })
      return
    }
    if (req.method === 'POST' && path === '/api/extensions/install') {
      const body = await readJson(req) as { manifest?: unknown; image?: { repo: string; tag: string; digest?: string } } | undefined
      if (!body || typeof body !== 'object' || !('manifest' in body) || typeof body.manifest !== 'object') {
        send(res, 400, { error: 'body must be { manifest: ExtensionManifest, image?: { repo, tag, digest? } }' })
        return
      }
      const source: InstallSource = {
        kind: 'manifest',
        manifest: body.manifest as ImportableManifest,
        image: body.image,
      }
      const result = await opts.manager.install(source)
      // token material never appears in any response
      send(res, 201, result)
      return
    }
    const lifecycle = /^\/api\/extensions\/([a-z0-9-]+)\/(stop|restart|remove)$/.exec(path)
    if (req.method === 'POST' && lifecycle) {
      const [, id, verb] = lifecycle
      if (verb === 'stop') await opts.manager.stop(id)
      else if (verb === 'restart') await opts.manager.restart(id)
      else await opts.manager.remove(id)
      send(res, 200, { extensionId: id, verb, ok: true })
      return
    }
    if (req.method === 'GET' && /^\/api\/extensions\/([a-z0-9-]+)$/.test(path)) {
      const id = path.split('/')[3]
      const rec = opts.manager.get(id)
      if (!rec) {
        send(res, 404, { error: `unknown extension "${id}"` })
        return
      }
      send(res, 200, rec)
      return
    }
    // §17.2 step 5: the registration package Core consumes to mount the
    // extension's providers. Contains the extension token — manager-internal
    // surface only (this API is never internet-facing, RFC §19.5).
    if (req.method === 'GET' && /^\/api\/extensions\/([a-z0-9-]+)\/registration$/.test(path)) {
      const id = path.split('/')[3]
      const pkg = await opts.manager.registrationPackage(id)
      send(res, 200, pkg)
      return
    }

    send(res, 404, { error: `no such route: ${req.method} ${path}` })
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) })
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(sha256Hex(a))
  const bb = Buffer.from(sha256Hex(b))
  return ab.equals(bb)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return undefined
  return JSON.parse(text) as unknown
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}
