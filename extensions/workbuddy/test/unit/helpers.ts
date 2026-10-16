/**
 * Test harness: boots a real app instance (temp SQLite store) bound to an
 * ephemeral port, with the WorkBuddyCN upstream pointed at the fake upstream.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startApp, type App } from '../../src/index.js'
import type { AppConfig } from '../../src/util/config.js'
import { FakeWorkBuddyCN } from '../fake/upstream.js'

export interface HarnessResult {
  app: App
  base: string
  port: number
  fake: FakeWorkBuddyCN
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
  /** Start an SSE chat request and return the raw Response (for frame tests). */
  chatStream: (body: Record<string, unknown>, opts?: { token?: string | null; signal?: AbortSignal }) => Promise<Response>
}

export async function startHarness(overrides: {
  fake?: FakeWorkBuddyCN
  authToken?: string
  config?: Partial<AppConfig>
} = {}): Promise<HarnessResult> {
  const fake = overrides.fake ?? new FakeWorkBuddyCN()
  await fake.listen()
  const storeDir = mkdtempSync(join(tmpdir(), 'wbcn-ext-'))
  const config: AppConfig = {
    port: 0,
    host: '127.0.0.1',
    authToken: overrides.authToken,
    extensionId: 'workbuddycn',
    dataDir: join(storeDir, 'data'),
    logLevel: 'error',
    upstreamEndpoint: fake.endpoint(),
    upstreamDomain: fake.endpoint().replace(/^https?:\/\//, ''),
    productCode: 'codebuddy',
    userAgent: 'CodeBuddyIDE/1.106.1',
    requestTimeoutMs: 10_000,
    stateRequestTimeoutMs: 10_000,
    streamFirstTokenTimeoutMs: 20_000,
    streamChunkIdleTimeoutMs: 20_000,
    loginTtlSeconds: 300,
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
    app,
    base,
    port,
    fake,
    storeDir,
    config,
    close: async () => {
      await app.close()
      await fake.close()
      rmSync(storeDir, { recursive: true, force: true })
    },
    request,
    chatStream,
  }
}

/** Parse an SSE body into {event, data} frames. */
export function parseSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = []
  for (const block of text.split('\n\n')) {
    let event = 'message'
    let dataLine = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLine += line.slice(5).trim()
    }
    if (!dataLine) continue
    try {
      frames.push({ event, data: JSON.parse(dataLine) as Record<string, unknown> })
    } catch {
      frames.push({ event, data: { _raw: dataLine } })
    }
  }
  return frames
}
