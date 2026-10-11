/**
 * DockerRuntime unit tests over a stubbed Docker Engine API (unix-socket
 * fetch is injected, so these run on hosts without Docker).
 */
import { describe, expect, it } from 'vitest'
import { DockerRuntime } from '../src/manager/docker-api.js'
import type { SanitizedContainerSpec } from '../src/manager/runtime.js'

const sanitizedSpec = (name: string, network = 'gw-ext-net'): SanitizedContainerSpec => ({
  name,
  image: { repo: 'local/gateway-extension-lobsterai', tag: '1.0.0' },
  port: 8080,
  env: { GATEWAY_EXTENSION_TOKEN: 't', GATEWAY_EXTENSION_ID: 'lobsterai' },
  volumes: [{ name: 'state', mountPath: '/data' }],
  labels: { 'gateway.extension.id': 'lobsterai' },
  capDrop: 'ALL',
  privileged: false,
  readonlyRootfs: true,
  restartPolicy: 'unless-stopped',
  memoryBytes: 512 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  network,
} as unknown as SanitizedContainerSpec)

/** Minimal Docker Engine API stub covering the paths DockerRuntime touches. */
function stubEngine(routes: Map<string, { status: number; body: unknown }>) {
  const calls: Array<{ method: string; path: string }> = []
  const impl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = String(input)
    const after = raw.split(/^https?:\/\/[^/]+\//, 2)[1] ?? ''
    const path = '/' + after.replace(/^v1\.\d+\//, '').replace(/^\//, '')
    calls.push({ method: init?.method ?? 'GET', path })
    const hit = routes.get(`${init?.method ?? 'GET'} ${path}`) ?? routes.get(`GET ${path}`)
    if (!hit) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 })
    return new Response(JSON.stringify(hit.body), { status: hit.status })
  }) as typeof fetch
  return { impl, calls }
}

const baseRoutes = () => new Map([
  ['GET /images/local%2Fgateway-extension-lobsterai%3A1.0.0/json', { status: 200, body: { Id: 'sha256:' + 'a'.repeat(64) } }],
  ['POST /containers/create?name=gw-ext-lobsterai', { status: 201, body: { Id: 'c0ffee' } }],
  ['POST /containers/c0ffee/start', { status: 204, body: null }],
])

describe('DockerRuntime (stubbed engine)', () => {
  it('pullImage prefers a locally built image and records its id as digest', async () => {
    const { impl, calls } = stubEngine(baseRoutes())
    const rt = new DockerRuntime({ fetchImpl: impl })
    const { digest } = await rt.pullImage({ repo: 'local/gateway-extension-lobsterai', tag: '1.0.0' })
    expect(digest).toBe('sha256:' + 'a'.repeat(64))
    expect(calls.some((c) => c.path.startsWith('/images/create'))).toBe(false)
  })

  it('pullImage falls back to the registry when the image is not local', async () => {
    const routes = new Map([
      ['GET /images/local%2Fgateway-extension-lobsterai%3A1.0.0/json', { status: 404, body: { message: 'no such image' } }],
      ['GET /distribution/local%2Fgateway-extension-lobsterai%3A1.0.0/json', { status: 200, body: { descriptor: { digest: 'sha256:' + 'b'.repeat(64) } } }],
      ['POST /images/create?fromImage=local%2Fgateway-extension-lobsterai&tag=1.0.0', { status: 200, body: null }],
    ])
    const { impl, calls } = stubEngine(routes)
    const rt = new DockerRuntime({ fetchImpl: impl })
    const { digest } = await rt.pullImage({ repo: 'local/gateway-extension-lobsterai', tag: '1.0.0' })
    expect(digest).toBe('sha256:' + 'b'.repeat(64))
    expect(calls.some((c) => c.path.startsWith('/images/create'))).toBe(true)
  })

  it('pullImage honors a pinned digest mismatch', async () => {
    const { impl } = stubEngine(baseRoutes())
    const rt = new DockerRuntime({ fetchImpl: impl })
    await expect(rt.pullImage({ repo: 'local/gateway-extension-lobsterai', tag: '1.0.0', digest: 'sha256:' + 'c'.repeat(64) }))
      .rejects.toThrow(/digest mismatch/)
  })

  it('createContainer builds a hardened spec and never publishes ports', async () => {
    const routes = baseRoutes()
    let captured: Record<string, unknown> | undefined
    const { impl } = stubEngineWithCapture(routes, (body) => { captured = body })
    const rt = new DockerRuntime({ fetchImpl: impl })
    const handle = await rt.createContainer(sanitizedSpec('gw-ext-lobsterai'))
    expect(handle.endpointUrl).toBe('http://gw-ext-lobsterai:8080')
    const hostConfig = (captured as { HostConfig?: Record<string, unknown> })?.HostConfig ?? {}
    expect(hostConfig['Privileged']).toBe(false)
    expect(hostConfig['PortBindings']).toEqual({})
    expect(hostConfig['ReadonlyRootfs']).toBe(true)
  })
})

/** like stubEngine but hands the create-container body to the test. */
function stubEngineWithCapture(
  routes: Map<string, { status: number; body: unknown }>,
  onCreate: (body: unknown) => void,
) {
  const impl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = String(input)
    const after = raw.split(/^https?:\/\/[^/]+\//, 2)[1] ?? ''
    const path = '/' + after.replace(/^v1\.\d+\//, '').replace(/^\//, '')
    if (path.startsWith('/containers/create')) onCreate(JSON.parse(String(init?.body ?? '{}')))
    const hit = routes.get(`${init?.method ?? 'GET'} ${path}`) ?? routes.get(`GET ${path}`)
    if (!hit) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 })
    return new Response(JSON.stringify(hit.body), { status: hit.status })
  }) as typeof fetch
  return { impl }
}
