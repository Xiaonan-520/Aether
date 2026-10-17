/**
 * MiniMax Extension E2E — the full protocol surface over real HTTP, against a
 * stubbed MiniMax upstream (no real credentials in CI).
 *
 * Covers: manifest/health → OAuth device-code login → models → non-stream chat
 * → SSE streaming (including empty-frame suppression) → tool calls and result
 * backfill → error classification → refresh → enable/disable.
 *
 * Runs for BOTH products (minimax / minimaxintl): one image, two sites.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMinimaxExtension } from '../src/extensions/minimax/main.js'
import { MINIMAX, MINIMAX_INTL } from '../src/providers/minimax/protocol.js'
import { buildRemoteProviders } from '../src/protocol/extension/remote-provider.js'
import { validateManifest } from '../src/protocol/extension/validate-manifest.js'

const AUTH = { 'content-type': 'application/json', authorization: 'Bearer e2e-ext-token' }

/** Anthropic-shaped SSE frames the way the real upstream emits them. */
function sse(frames: string[]): Response {
  return new Response(frames.join('\n\n') + '\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function ev(type: string, payload: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ type, ...payload })}`
}

interface Bar { chatStatus?: number; frames?: string[]; catalog?: unknown }

function stubUpstream(bar: Bar): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/oauth2/device/code')) {
      return new Response(JSON.stringify({
        device_code: 'dev-code-1',
        user_code: 'USER-1',
        verification_uri: 'https://example/activate',
        verification_uri_complete: 'https://example/activate?code=USER-1',
        expires_in: 600,
        interval: 1,
      }), { status: 200 })
    }
    if (url.includes('/oauth2/token')) {
      return new Response(JSON.stringify({
        access_token: 'acc-1',
        refresh_token: 'ref-1',
        expires_in: 3600,
      }), { status: 200 })
    }
    if (url.includes('/mavis/api/v1/models')) {
      if (bar.catalog) return new Response(JSON.stringify(bar.catalog), { status: 200 })
      return new Response(JSON.stringify({ models: [{ id: 'MiniMax-M3', name: 'M3' }] }), { status: 200 })
    }
    if (url.includes('/mavis/api/v1/llm/v1/messages')) {
      if (bar.chatStatus && bar.chatStatus !== 200) {
        return new Response(JSON.stringify({ error: { type: 'x', message: 'upstream down' } }), { status: bar.chatStatus })
      }
      return sse(bar.frames ?? [
        ev('message_start', { message: { usage: { input_tokens: 5 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' world' } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
        ev('message_stop'),
      ])
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

async function boot(product: typeof MINIMAX, bar: Bar = {}) {
  const dir = mkdtempSync(join(tmpdir(), `gw-${product.id}-`))
  process.env.GATEWAY_EXTENSION_TOKEN = 'e2e-ext-token'
  const ext = await startMinimaxExtension({
    dataDir: join(dir, 'data'),
    secret: 'e2e-secret-0123456789abcdef',
    fetcher: stubUpstream(bar),
    product,
  })
  return {
    ext,
    close: async () => {
      await new Promise<void>((r) => ext.server.close(() => r()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function login(ext: Awaited<ReturnType<typeof boot>>['ext']): Promise<string> {
  const created = await fetch(`${ext.endpointUrl}/v1/accounts`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({}),
  })
  const body = await created.json() as { accountId: string; authorizationUrl: string; userCode: string }
  expect(created.status).toBe(201)
  expect(body.authorizationUrl).toContain('activate')
  expect(body.userCode).toBe('USER-1')
  // Core's pollLogin re-reads the projection, which advances the device state.
  for (let i = 0; i < 10; i++) {
    const d = await fetch(`${ext.endpointUrl}/v1/accounts/${body.accountId}`, { headers: AUTH })
    const j = await d.json() as { account: { status: string } }
    if (j.account.status === 'active') return body.accountId
  }
  throw new Error('device login did not complete')
}

describe.each([
  ['minimax', MINIMAX] as const,
  ['minimaxintl', MINIMAX_INTL] as const,
])('%s extension', (label, product) => {
  it('serves a valid manifest with the right provider id', async () => {
    const h = await boot(product)
    try {
      const res = await fetch(`${h.ext.endpointUrl}/manifest`)
      expect(res.status).toBe(200)
      const man = await res.json()
      expect(man.extension.id).toBe(label)
      expect(man.providers[0].id).toBe(label)
      expect(man.runtime.healthPath).toBe('/health')
      const v = validateManifest(man)
      expect(v.ok).toBe(true)
    } finally { await h.close() }
  })

  it('answers EXTENSION_AUTH (not AUTH_INVALID) for a bad extension token', async () => {
    const h = await boot(product)
    try {
      const res = await fetch(`${h.ext.endpointUrl}/v1/accounts`, {
        headers: { authorization: 'Bearer wrong' },
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: { kind: 'EXTENSION_AUTH' } })
    } finally { await h.close() }
  })

  it('forbids credentials in account creation (RFC §10.3)', async () => {
    const h = await boot(product)
    try {
      const res = await fetch(`${h.ext.endpointUrl}/v1/accounts`, {
        method: 'POST', headers: AUTH, body: JSON.stringify({ access_token: 'x' }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: { kind: 'PROTOCOL_VIOLATION' } })
    } finally { await h.close() }
  })

  it('completes the device-code login and never returns a credential', async () => {
    const h = await boot(product)
    try {
      const id = await login(h.ext)
      const res = await fetch(`${h.ext.endpointUrl}/v1/accounts`, { headers: AUTH })
      const body = await res.json()
      expect(JSON.stringify(body)).not.toContain('acc-1')
      expect(JSON.stringify(body)).not.toContain('ref-1')
      expect(JSON.stringify(body)).toContain(id)
    } finally { await h.close() }
  })

  it('lists models from the catalog', async () => {
    const h = await boot(product, { catalog: { models: [{ id: 'MiniMax-M3.1-Flash-Preview', name: 'M3.1' }] } })
    try {
      const id = await login(h.ext)
      const res = await fetch(`${h.ext.endpointUrl}/v1/models?account_id=${id}`, { headers: AUTH })
      expect(await res.json()).toMatchObject({ models: [{ id: 'MiniMax-M3.1-Flash-Preview' }] })
    } finally { await h.close() }
  })

  it('non-stream chat aggregates text and usage', async () => {
    const h = await boot(product)
    try {
      const id = await login(h.ext)
      const res = await fetch(`${h.ext.endpointUrl}/v1/chat`, {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ accountId: id, model: label + '::MiniMax-M3', messages: [{ role: 'user', content: 'hi' }], stream: false }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { content: string; finishReason: string }
      expect(body.content).toBe('Hello world')
      expect(body.finishReason).toBe('stop')
    } finally { await h.close() }
  })

  it('stream chat emits only real increments and a terminal frame', async () => {
    const h = await boot(product, {
      frames: [
        ev('message_start', { message: { usage: { input_tokens: 3 } } }),
        ev('ping'),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        // empty text delta must NOT become a chunk
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'A' } }),
        // signature delta must NEVER become text
        ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'deadbeef' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'B' } }),
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
        ev('message_stop'),
      ],
    })
    try {
      const id = await login(h.ext)
      const res = await fetch(`${h.ext.endpointUrl}/v1/chat`, {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ accountId: id, model: label + '::MiniMax-M3', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      })
      const text = await res.text()
      const payloads = text.split('\n\n')
        .filter((b) => b.includes('event: chunk'))
        .map((b) => JSON.parse(b.split('data: ')[1]!) as Record<string, unknown>)
      const increments = payloads.filter((p) => !p.finishReason)
      // exactly the two real text deltas
      expect(increments.map((p) => p.text).join('')).toBe('AB')
      expect(payloads.every((p) => p.reasoning === undefined)).toBe(true)
      expect(text).not.toContain('deadbeef') // signature never leaks
      expect(text).toContain('"finishReason":"stop"')
    } finally { await h.close() }
  })

  it('maps thinking_delta to reasoning without polluting content', async () => {
    const h = await boot(product, {
      frames: [
        ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'let me think' } }),
        ev('content_block_stop', { index: 0 }),
        ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'answer' } }),
        ev('message_delta', { delta: { stop_reason: 'end_turn' } }),
        ev('message_stop'),
      ],
    })
    try {
      const id = await login(h.ext)
      const res = await fetch(`${h.ext.endpointUrl}/v1/chat`, {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ accountId: id, model: label + '::MiniMax-M3', messages: [{ role: 'user', content: 'hi' }], stream: false }),
      })
      const body = await res.json() as { content: string; reasoning?: string }
      expect(body.reasoning).toBe('let me think')
      expect(body.content).toBe('answer')
    } finally { await h.close() }
  })

  it('round-trips tool calls and tool results', async () => {
    const h = await boot(product, {
      frames: [
        ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'bash' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"comm' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'and":"ls"}' } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'tool_use' } }),
        ev('message_stop'),
      ],
    })
    try {
      const id = await login(h.ext)
      const res = await fetch(`${h.ext.endpointUrl}/v1/chat`, {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({
          accountId: id, model: label + '::MiniMax-M3', stream: false,
          tools: [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } }],
          messages: [{ role: 'user', content: 'run ls' }],
        }),
      })
      const body = await res.json() as { finishReason: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }
      expect(body.finishReason).toBe('tool_calls')
      expect(body.toolCalls).toEqual([{ id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }])
    } finally { await h.close() }
  })

  it('classifies upstream failures honestly', async () => {
    const h = await boot(product, { chatStatus: 401 })
    try {
      const id = await login(h.ext)
      const res = await fetch(`${h.ext.endpointUrl}/v1/chat`, {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ accountId: id, model: label + '::MiniMax-M3', messages: [{ role: 'user', content: 'x' }], stream: false }),
      })
      expect(res.status).toBe(502)
      expect(await res.json()).toMatchObject({ error: { kind: 'AUTH_INVALID' } })
    } finally { await h.close() }
  })

  it('refresh rotates the stored refresh token', async () => {
    const h = await boot(product)
    try {
      const id = await login(h.ext)
      const res = await fetch(`${h.ext.endpointUrl}/v1/accounts/${id}/refresh`, { method: 'POST', headers: AUTH })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ refreshed: true })
    } finally { await h.close() }
  })

  it('disable/enable flips the projection', async () => {
    const h = await boot(product)
    try {
      const id = await login(h.ext)
      await fetch(`${h.ext.endpointUrl}/v1/accounts/${id}/disable`, { method: 'POST', headers: AUTH })
      const off = await (await fetch(`${h.ext.endpointUrl}/v1/accounts`, { headers: AUTH })).json() as { accounts: Array<{ status: string }> }
      expect(off.accounts[0]?.status).toBe('disabled')
      await fetch(`${h.ext.endpointUrl}/v1/accounts/${id}/enable`, { method: 'POST', headers: AUTH })
      const on = await (await fetch(`${h.ext.endpointUrl}/v1/accounts`, { headers: AUTH })).json() as { accounts: Array<{ status: string }> }
      expect(on.accounts[0]?.status).toBe('active')
    } finally { await h.close() }
  })

  it('mounts through the Core RemoteProvider seam', async () => {
    const h = await boot(product)
    try {
      await login(h.ext)
      const [provider] = buildRemoteProviders({
        manifest: structuredClone(h.ext.manifest),
        endpoints: { baseUrl: h.ext.endpointUrl, token: 'e2e-ext-token' },
      })
      expect(provider!.id).toBe(label)
    } finally { await h.close() }
  })
})

afterAll(() => {
  delete process.env.GATEWAY_EXTENSION_TOKEN
})

describe.each([
  ['minimax', MINIMAX] as const,
  ['minimaxintl', MINIMAX_INTL] as const,
])('%s declared action', (label, product) => {
  it('serves the read-only account-status action without leaking credentials', async () => {
    const h = await boot(product)
    try {
      const id = await login(h.ext)
      const res = await fetch(`${h.ext.endpointUrl}/v1/actions/account-status`, {
        method: 'POST', headers: AUTH, body: JSON.stringify({ payload: { account_id: id } }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { result: { accountId: string; status: string; region: string } }
      expect(body.result).toMatchObject({ accountId: id, status: 'active', region: product.region })
      const raw = JSON.stringify(body)
      expect(raw).not.toContain('acc-1')
      expect(raw).not.toContain('ref-1')
    } finally { await h.close() }
  })
})
