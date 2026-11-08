/**
 * Test harness: boots a real app instance (temp SQLite store) bound to an
 * ephemeral port, with the ZCode upstream pointed at the fake upstream.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startApp, type App } from '../../src/index.js'
import type { AppConfig } from '../../src/util/config.js'
import { FakeZCode } from '../fake/upstream.js'

export interface HarnessResult {
  app: App
  base: string
  port: number
  fake: FakeZCode
  storeDir: string
  config: AppConfig
  close: () => Promise<void>
  request: (
    method: string,
    path: string,
    body?: unknown,
    opts?: { token?: string | null },
  ) => Promise<{
    status: number
    headers: Headers
    text: () => Promise<string>
    json: () => Promise<Record<string, unknown>>
  }>
  chatStream: (body: Record<string, unknown>, opts?: { token?: string | null; signal?: AbortSignal }) => Promise<Response>
}

export async function startHarness(overrides: {
  fake?: FakeZCode
  authToken?: string
  config?: Partial<AppConfig>
} = {}): Promise<HarnessResult> {
  const fake = overrides.fake ?? new FakeZCode()
  await fake.listen()
  const storeDir = mkdtempSync(join(tmpdir(), 'zcode-ext-'))
  const config: AppConfig = {
    port: 0,
    host: '127.0.0.1',
    authToken: overrides.authToken ?? 'test-token',
    extensionId: 'zcode',
    dataDir: join(storeDir, 'data'),
    logLevel: 'error',
    upstreamApiBase: `${fake.endpoint()}/api/v1`,
    requestTimeoutMs: 10_000,
    stateRequestTimeoutMs: 10_000,
    captchaWaitMs: 1_000,
    ...overrides.config,
  }
  const app = await startApp(config)
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  const base = `http://127.0.0.1:${port}`
  const token = config.authToken

  const headersFor = (opts: { token?: string | null } = {}): Headers => {
    const headers = new Headers()
    const effective = opts.token === undefined ? token : (opts.token ?? undefined)
    if (effective) headers.set('Authorization', `Bearer ${effective}`)
    return headers
  }

  const request = async (method: string, path: string, body?: unknown, opts: { token?: string | null } = {}) => {
    const headers = headersFor(opts)
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    const res = await fetch(base + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return {
      status: res.status,
      headers: res.headers,
      text: async () => res.text(),
      json: async () => (await res.json()) as Record<string, unknown>,
    }
  }

  const chatStream = async (body: Record<string, unknown>, opts: { token?: string | null; signal?: AbortSignal } = {}) => {
    const headers = headersFor(opts)
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'text/event-stream')
    return fetch(base + '/v1/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: true }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  }

  return {
    app: app,
    base: base,
    port: port,
    fake: fake,
    storeDir: storeDir,
    config: config,
    close: async () => {
      await app.close()
      await fake.close()
      rmSync(storeDir, { recursive: true, force: true })
    },
    request: request,
    chatStream: chatStream,
  }
}
