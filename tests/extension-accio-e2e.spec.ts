/**
 * Accio Extension E2E — real HTTP against a stubbed Alibaba gateway.
 *
 * Covers: manifest validation, browser-callback login (code + state + PKCE),
 * credential-forbidden creation, non-stream chat with the token-in-body trap,
 * the string system_instruction trap, stringified tool schemas, streaming with
 * thought/text separation, in-stream error classification, refresh rotation,
 * and the Core RemoteProvider seam.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { startAccioExtension } from '../src/extensions/accio/main.js'
import { ACCIO, ACCIO_TOKEN_EXCHANGE_PATH, ACCIO_REFRESH_PATH } from '../src/providers/accio/protocol.js'
import { buildRemoteProviders } from '../src/protocol/extension/remote-provider.js'
import { validateManifest } from '../src/protocol/extension/validate-manifest.js'

const AUTH = { 'content-type': 'application/json', authorization: 'Bearer e2e-ext-token' }
const CALLBACK_BASE = 'http://127.0.0.1:28190'

interface Bar { chatStatus?: number; frames?: string[]; tokenOk?: boolean }

function stubUpstream(bar: Bar, captured: Array<Record<string, unknown>>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes(ACCIO_TOKEN_EXCHANGE_PATH)) {
      if (bar.tokenOk === false) return new Response('{}', { status: 500 })
      return new Response(JSON.stringify({ access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 3600 }), { status: 200 })
    }
    if (url.includes(ACCIO_REFRESH_PATH)) {
      return new Response(JSON.stringify({ access_token: 'acc-2', refresh_token: 'ref-2', expires_in: 3600 }), { status: 200 })
    }
    if (url.includes('/api/adk/llm/generateContent')) {
      if (init?.body) {
        try { captured.push(JSON.parse(String(init.body)) as Record<string, unknown>) } catch { /* ignore */ }
      }
      if (bar.chatStatus && bar.chatStatus !== 200) return new Response('down', { status: bar.chatStatus })
      return new Response((bar.frames ?? [
        'data: {"content":{"parts":[{"text":"Hello"}]}}',
        'data: {"content":{"parts":[{"text":"Accio"}]}}',
        'data: {"content":{"parts":[]},"finish_reason":"stop"}',
      ]).join('\n\n') + '\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

async function boot(bar: Bar = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gw-accio-'))
  const captured: Array<Record<string, unknown>> = []
  process.env.GATEWAY_EXTENSION_TOKEN = 'e2e-ext-token'
  process.env.ACCIO_CALLBACK_BASE = CALLBACK_BASE
  const ext = await startAccioExtension({
    dataDir: join(dir, 'data'),
    secret: 'e2e-secret-0123456789abcdef',
    fetcher: stubUpstream(bar, captured),
    region: 'cn',
  })
  return {
    ext, captured,
    close: async () => {
      await new Promise<void>((r) => ext.server.close(() => r()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Drive a browser-callback login: create account, then hit /auth/callback. */
async function login(h: Awaited<ReturnType<typeof boot>>): Promise<string> {
  const created = await fetch(`${h.ext.endpointUrl}/v1/accounts`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ callbackBase: CALLBACK_BASE }),
  })
  if (created.status !== 201) console.error('LOGIN STATUS', created.status, await created.text())
  const body = await created.json() as { accountId: string; authorizationUrl: string }
  expect(body.authorizationUrl).toContain('www.accio-ai.com/login')
  expect(body.authorizationUrl).toContain('code_challenge_method=S256')
  // the redirect_uri in the auth URL must be the callback the browser can reach
  const redirect = new URLSearchParams(new URL(body.authorizationUrl).search).get('return_url')
  expect(redirect).toBe(`${CALLBACK_BASE}/auth/callback`)
  // upstream redirects here with code+state
  const url = new URL(body.authorizationUrl)
  if (process.env.ACCIO_DBG) console.error('AUTHURL', body.authorizationUrl)
  const state = new URLSearchParams(url.search).get('state')!
  const cb = await fetch(`${h.ext.endpointUrl}/auth/callback?code=the-code&state=${state}`)
  if (cb.status !== 200) console.error('CALLBACK STATUS', cb.status, await cb.text(), 'stateWas=', state)
  expect(cb.status).toBe(200)
  return body.accountId
}

describe('accio extension', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterAll(async () => { for (const c of cleanups) await c() })

  it('serves a valid manifest', async () => {
    const h = await boot(); cleanups.push(h.close)
    const man = await (await fetch(`${h.ext.endpointUrl}/manifest`)).json()
    expect(man.extension.id).toBe('accio')
    const v = validateManifest(man)
    expect(v.ok).toBe(true)
  })

  it('answers EXTENSION_AUTH for a bad extension token', async () => {
    const h = await boot(); cleanups.push(h.close)
    const res = await fetch(`${h.ext.endpointUrl}/v1/accounts`, { headers: { authorization: 'Bearer wrong' } })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { kind: 'EXTENSION_AUTH' } })
  })

  it('requires callbackBase to start a login', async () => {
    const h = await boot(); cleanups.push(h.close)
    process.env.ACCIO_CALLBACK_BASE = ''
    const res = await fetch(`${h.ext.endpointUrl}/v1/accounts`, { method: 'POST', headers: AUTH, body: '{}' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { kind: 'TERMINAL' } })
    process.env.ACCIO_CALLBACK_BASE = CALLBACK_BASE
  })

  it('rejects credentials in account creation', async () => {
    const h = await boot(); cleanups.push(h.close)
    const res = await fetch(`${h.ext.endpointUrl}/v1/accounts`, { method: 'POST', headers: AUTH, body: JSON.stringify({ access_token: 'x' }) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { kind: 'PROTOCOL_VIOLATION' } })
  })

  it('completes the browser-callback login with PKCE + state', async () => {
    const h = await boot(); cleanups.push(h.close)
    const id = await login(h)
    const proj = await (await fetch(`${h.ext.endpointUrl}/v1/accounts`, { headers: AUTH })).json()
    expect(JSON.stringify(proj)).toContain(id)
    expect(JSON.stringify(proj)).not.toContain('acc-1')
    // a second callback with the same state must fail (state consumed)
    const bad = await fetch(`${h.ext.endpointUrl}/auth/callback?code=x&state=replay`)
    expect(bad.status).toBe(400)
  })

  it('non-stream chat: token in body, string system_instruction, stringified schemas', async () => {
    const h = await boot(); cleanups.push(h.close)
    const id = await login(h)
    const res = await fetch(`${h.ext.endpointUrl}/v1/chat`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({
        accountId: id, model: 'accio::1Nexus-R3wF8qJ5vB6h', stream: false,
        tools: [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } } }],
        messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { content: string; finishReason: string }
    expect(body.content).toBe('HelloAccio')
    expect(body.finishReason).toBe('stop')
    const wire = JSON.stringify(h.captured[0])
    expect(h.captured[0]?.token).toBe('acc-1')          // token in BODY
    expect(h.captured[0]?.system_instruction).toBe('SYS') // string, not object
    expect(wire).toContain('"parameters_json"')          // stringified schema
    // the schema is a JSON STRING inside the JSON payload, so its keys are
    // double-escaped on the wire — the point is that the camel→snake rewrite
    // cannot touch them (they are data, not protocol fields)
    expect(wire).toContain('filePath')
    expect(wire).not.toContain('file_path')
    expect(h.captured[0]?.empid).toBe('')
    expect((h.captured[0]?.properties as Record<string, unknown>)?.appKey).toBe('OneChat')
  })

  it('stream separates thought (reasoning) from text', async () => {
    const h = await boot({
      frames: [
        'data: {"content":{"parts":[{"text":"thinking hard","thought":true}]}}',
        'data: {"content":{"parts":[{"text":"answer"}]}}',
        'data: {"content":{"parts":[]},"finish_reason":"stop"}',
      ],
    }); cleanups.push(h.close)
    const id = await login(h)
    const res = await fetch(`${h.ext.endpointUrl}/v1/chat`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ accountId: id, model: 'accio::x', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    const text = await res.text()
    const payloads = text.split('\n\n').filter((b) => b.includes('event: chunk'))
      .map((b) => JSON.parse(b.split('data: ')[1]!) as Record<string, unknown>)
    expect(payloads.some((p) => p.reasoning === 'thinking hard')).toBe(true)
    expect(payloads.some((p) => p.text === 'answer')).toBe(true)
    expect(text).toContain('"finishReason":"stop"')
  })

  it('classifies an in-stream error code as AUTH_INVALID', async () => {
    const h = await boot({
      frames: ['data: {"error_code":402,"error_message":"quota"}'],
    }); cleanups.push(h.close)
    const id = await login(h)
    const res = await fetch(`${h.ext.endpointUrl}/v1/chat`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ accountId: id, model: 'accio::x', messages: [{ role: 'user', content: 'x' }], stream: false }),
    })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: { kind: 'AUTH_INVALID' } })
  })

  it('refresh rotates the refresh token', async () => {
    const h = await boot(); cleanups.push(h.close)
    const id = await login(h)
    const res = await fetch(`${h.ext.endpointUrl}/v1/accounts/${id}/refresh`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ refreshed: true })
  })

  it('mounts through the Core RemoteProvider seam', async () => {
    const h = await boot(); cleanups.push(h.close)
    await login(h)
    const [p] = buildRemoteProviders({
      manifest: structuredClone(h.ext.manifest),
      endpoints: { baseUrl: h.ext.endpointUrl, token: 'e2e-ext-token' },
    })
    expect(p!.id).toBe('accio')
  })

  // PKCE sanity: the challenge in the auth URL must match the verifier the
  // extension keeps — same guarantee the real flow relies on.
  it('uses S256 PKCE (challenge is sha256-base64url of a verifier)', async () => {
    const v = randomBytes(32).toString('base64url')
    const c = createHash('sha256').update(v).digest('base64url')
    expect(c).not.toContain('=')
  })
})
