/**
 * Provider behaviour tests: error-kind mapping, timeout, cancellation,
 * persistence/restart, model filtering, and credential redaction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, parseSse, type HarnessResult } from './helpers.js'
import { errors, ProtocolError } from '../../src/protocol/errors.js'

describe('WorkBuddyCN provider behaviour', () => {
  let h: HarnessResult

  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    if (h) await h.close()
  })

  it('maps upstream 429 to RATE_LIMIT (retryable)', async () => {
    const accountId = await login(h)
    h.fake.behaviour.chatStatus = 429
    const res = await h.request('POST', '/v1/chat', {
      accountId, model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: false,
    })
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error.kind).toBe('RATE_LIMIT')
    expect(body.error.retryable).toBe(true)
  })

  it('maps upstream 401 to AUTH_INVALID', async () => {
    const accountId = await login(h)
    h.fake.behaviour.chatStatus = 401
    const res = await h.request('POST', '/v1/chat', {
      accountId, model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: false,
    })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.kind).toBe('AUTH_INVALID')
    expect(JSON.stringify(body)).not.toMatch(/access_token|fake-access/i)
  })

  it('maps upstream 500 to UPSTREAM_5XX', async () => {
    const accountId = await login(h)
    h.fake.behaviour.chatStatus = 500
    const res = await h.request('POST', '/v1/chat', {
      accountId, model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: false,
    })
    expect(res.status).toBe(502)
    expect((await res.json()).error.kind).toBe('UPSTREAM_5XX')
  })

  it('maps upstream 400 to TERMINAL', async () => {
    const accountId = await login(h)
    h.fake.behaviour.chatStatus = 400
    const res = await h.request('POST', '/v1/chat', {
      accountId, model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: false,
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.kind).toBe('TERMINAL')
  })

  it('maps a hanging upstream to TIMEOUT within the deadline', async () => {
    await h.close()
    h = await startHarness({ config: { requestTimeoutMs: 4000, streamFirstTokenTimeoutMs: 3000, streamChunkIdleTimeoutMs: 3000 } })
    const accountId = await login(h)
    h.fake.behaviour.chatHangSecs = 30
    const started = Date.now()
    const res = await h.request('POST', '/v1/chat', {
      accountId, model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: false,
    })
    const kind = (await res.json()).error?.kind
    expect(['TIMEOUT', 'TRANSPORT']).toContain(kind)
    expect(Date.now() - started).toBeLessThan(12_000)
  })

  it('streaming timeout emits an error frame and terminates', async () => {
    await h.close()
    h = await startHarness({ config: { streamFirstTokenTimeoutMs: 1200, streamChunkIdleTimeoutMs: 1200, requestTimeoutMs: 5000 } })
    const accountId = await login(h)
    h.fake.behaviour.chatHangSecs = 30
    const res = await h.chatStream({ accountId, model: 'x', messages: [{ role: 'user', content: 'hi' }] })
    const frames = parseSse(await res.text())
    const terminals = frames.filter((f) => f.event === 'done' || f.event === 'error')
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.event).toBe('error')
    const err = terminals[0]!.data.error as Record<string, unknown>
    expect(['TIMEOUT', 'TRANSPORT']).toContain(err.kind)
  })

  it('client disconnect aborts the upstream request', async () => {
    const accountId = await login(h)
    h.fake.behaviour.chatHangSecs = 60
    const controller = new AbortController()
    const res = await h.chatStream(
      { accountId, model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
      { signal: controller.signal },
    )
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    await reader.read()
    // Abort the client; the extension must release its upstream and registry entry.
    controller.abort()
    await new Promise((r) => setTimeout(r, 400))
    expect(h.app.registry.size()).toBe(0)
    // Evidence the upstream connection was truly aborted (not just forgotten).
    expect(h.fake.lastChatAborted).toBe(true)
    h.fake.behaviour.chatHangSecs = 0
    void reader.cancel().catch(() => undefined)
  })

  it('filters non-chat models from discovery', async () => {
    await login(h)
    h.fake.defaultModels = () => [
      { id: 'deepseek-v4-flash', name: 'Flash' },
      { id: 'completion-a', name: 'Completion A' },
      { id: 'nes-x', name: 'NES' },
    ]
    const models = (await (await h.request('GET', '/v1/models')).json()).models as Array<{ id: string }>
    const ids = models.map((m) => m.id)
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).not.toContain('completion-a')
    expect(ids).not.toContain('nes-x')
  })

  it('tolerates tool messages', async () => {
    const accountId = await login(h)
    const res = await h.request('POST', '/v1/chat', {
      accountId,
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: 'call tool' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
      stream: false,
    })
    expect(res.status).toBe(200)
  })

  it('persists credentials across a restart (decryptable, no key change)', async () => {
    const accountId = await login(h)
    const dataDir = `${h.storeDir}/data`
    // Stop the first instance WITHOUT deleting its data directory.
    await h.fake.close()
    await h.app.close()

    const reopened = await startHarness({ config: { dataDir } })
    try {
      const accounts = (await (await reopened.request('GET', '/v1/accounts')).json()).accounts as Array<Record<string, unknown>>
      const account = accounts.find((a) => a.accountId === accountId)
      expect(account).toBeDefined()
      expect(account!.status).toBe('active')
      // The credential must still be usable (AES-GCM decryption works after restart).
      const res = await reopened.request('POST', '/v1/chat', {
        accountId, model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: false,
      })
      expect(res.status).toBe(200)
    } finally {
      await reopened.close()
    }
    // The original `h` app is already closed; give afterEach a safe no-op.
    h = { ...h, close: async () => undefined }
  })

  it('keeps credentials out of logs', async () => {
    const lines: string[] = []
    const origOut = process.stdout.write.bind(process.stdout)
    const origErr = process.stderr.write.bind(process.stderr)
    const capture = (chunk: unknown): boolean => { lines.push(String(chunk)); return true }
    // @ts-expect-error test shim
    process.stdout.write = capture
    // @ts-expect-error test shim
    process.stderr.write = capture
    try {
      const accountId = await login(h)
      await h.request('GET', `/v1/accounts/${accountId}/quota`)
      await h.request('POST', '/v1/chat', { accountId, model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: false })
    } finally {
      process.stdout.write = origOut
      process.stderr.write = origErr
    }
    const joined = lines.join('')
    expect(joined).not.toMatch(/fake-access|fake-refresh/i)
    expect(joined).not.toMatch(/authorization: bearer/i)
  })

  it('error kinds are constrained to the protocol vocabulary', () => {
    const kinds = ['AUTH_INVALID', 'TOKEN_EXPIRED', 'RATE_LIMIT', 'QUOTA_EXHAUSTED', 'TIMEOUT', 'TRANSPORT', 'UPSTREAM_5XX', 'TERMINAL', 'EMPTY_RESPONSE', 'NEEDS_CAPTCHA', 'NEEDS_MANUAL', 'PROTOCOL_VIOLATION']
    for (const kind of kinds) {
      const e = new ProtocolError(kind as never)
      const body = e.toBody()
      expect(body.error.kind).toBe(kind)
      expect(typeof body.error.message).toBe('string')
    }
    expect(errors.rateLimit().toBody().error.kind).toBe('RATE_LIMIT')
  })
})

async function login(h: HarnessResult): Promise<string> {
  const id = `wbcn-${Math.random().toString(36).slice(2, 8)}`
  await h.request('POST', '/v1/accounts', { accountId: id, loginMode: 'external-link' })
  h.fake.behaviour.tokenReadyAfterPolls = 1
  for (let i = 0; i < 20; i++) {
    const detail = await h.request('GET', `/v1/accounts/${id}`)
    const status = ((await detail.json()).account as Record<string, unknown>).status
    if (status === 'active') return id
  }
  throw new Error('login did not complete')
}
