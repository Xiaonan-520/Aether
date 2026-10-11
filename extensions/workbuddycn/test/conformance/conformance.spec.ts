/**
 * Conformance tests — the Phase 3 Extension Protocol domains, exercised against
 * a real app instance backed by the fake WorkBuddyCN upstream.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, parseSse, type HarnessResult } from '../unit/helpers.js'
import { MANIFEST } from '../../src/protocol/manifest.js'
import { validateManifest } from '../../src/protocol/validate-manifest.js'

describe('Extension Protocol conformance (Phase 3)', () => {
  let h: HarnessResult

  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    if (h) await h.close()
  })

  // Domain 1 — Manifest
  describe('Domain 1: manifest', () => {
    it('passes the local schema + security validator', () => {
      const r = validateManifest(MANIFEST)
      expect(r.errors).toEqual([])
      expect(r.violations).toEqual([])
      expect(r.ok).toBe(true)
    })

    it('serves the manifest at GET /manifest', async () => {
      const res = await h.request('GET', '/manifest')
      expect(res.status).toBe(200)
      const m = await res.json()
      expect(m.apiVersion).toBe('1.0')
      const ext = m.extension as Record<string, unknown>
      expect(ext.id).toBe('workbuddycn')
      expect(ext.version).toMatch(/^\d+\.\d+\.\d+$/)
      const providers = m.providers as Array<Record<string, unknown>>
      expect(providers).toHaveLength(1)
      expect(providers[0].id).toBe('workbuddycn')
      const caps = providers[0].capabilities as Record<string, unknown>
      expect(caps.loginMode).toBe('external-link')
      expect(caps.needsCaptcha).toBe(false)
      const fallback = providers[0].fallbackModels as Array<{ id: string }>
      expect(fallback.length).toBeGreaterThan(0)
      // model ids must not carry a provider prefix
      expect(fallback.every((f) => !f.id.includes('::'))).toBe(true)
    })

    it('declares runtime port + healthPath consistent with the process', async () => {
      expect(MANIFEST.runtime.port).toBe(8080)
      expect(MANIFEST.runtime.healthPath).toBe('/health')
      const res = await h.request('GET', MANIFEST.runtime.healthPath)
      expect(res.status).toBe(200)
    })
  })

  // Domain 2 — Health
  describe('Domain 2: health', () => {
    it('returns a valid status and account counters', async () => {
      const res = await h.request('GET', '/health')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status)
      expect(body.accounts).toBeDefined()
    })

    it('health works without the extension token (container healthcheck)', async () => {
      await h.close()
      h = await startHarness({ authToken: 'secret-token' })
      const res = await h.request('GET', '/health', undefined, { token: null })
      expect(res.status).toBe(200)
    })
  })

  // Domain 3 — Models
  describe('Domain 3: models', () => {
    it('returns {models:[{id,name,capabilities}]} with no :: prefix', async () => {
      const res = await h.request('GET', '/v1/models')
      expect(res.status).toBe(200)
      const body = await res.json()
      const models = body.models as Array<{ id: string; name: string; capabilities: Record<string, unknown> }>
      expect(Array.isArray(models)).toBe(true)
      expect(models.length).toBeGreaterThan(0)
      expect(models.every((m) => typeof m.id === 'string' && typeof m.name === 'string')).toBe(true)
      expect(models.every((m) => !m.id.includes('::'))).toBe(true)
      expect(models[0].capabilities).toHaveProperty('streaming')
    })

    it('uses live discovery when an account is active', async () => {
      const accountId = await login(h)
      expect(accountId).toBeTruthy()
      const models = (await (await h.request('GET', '/v1/models')).json()).models as Array<{ id: string }>
      expect(models.some((m) => m.id === 'deepseek-v4-flash')).toBe(true)
    })
  })

  // Domain 4 — Account lifecycle
  describe('Domain 4: account lifecycle', () => {
    it('creates a pending account via POST /v1/accounts', async () => {
      const res = await h.request('POST', '/v1/accounts', { accountId: 'wbcn-abc', loginMode: 'external-link' })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.accountId).toBe('wbcn-abc')
      expect(body.status).toBe('pending')
      expect(typeof body.authorizationUrl).toBe('string')
      expect(String(body.authorizationUrl)).toContain('codebuddy.cn')
      expect(body.pollInterval).toBeGreaterThan(0)
    })

    it('rejects credential fields on account creation', async () => {
      const res = await h.request('POST', '/v1/accounts', { loginMode: 'external-link', access_token: 'x' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatchObject({ kind: 'PROTOCOL_VIOLATION' })
    })

    it('rejects unsupported login modes', async () => {
      const res = await h.request('POST', '/v1/accounts', { loginMode: 'sms' })
      expect(res.status).toBe(422)
    })

    it('lists accounts and returns detail; polling drives pending→active', async () => {
      const start = await h.request('POST', '/v1/accounts', { accountId: 'wbcn-life', loginMode: 'external-link' })
      expect(start.status).toBe(201)
      h.fake.behaviour.tokenReadyAfterPolls = 1

      const list = await h.request('GET', '/v1/accounts')
      const accounts = (await list.json()).accounts as Array<{ accountId: string; status: string }>
      const created = accounts.find((a) => a.accountId === 'wbcn-life')
      expect(created).toBeDefined()
      expect(created!.status).toBe('pending')

      let finalStatus = 'pending'
      for (let i = 0; i < 20 && finalStatus !== 'active'; i++) {
        const detail = await h.request('GET', '/v1/accounts/wbcn-life')
        finalStatus = String(((await detail.json()).account as Record<string, unknown>).status)
      }
      expect(finalStatus).toBe('active')

      const detail = await h.request('GET', '/v1/accounts/wbcn-life')
      const account = (await detail.json()).account as Record<string, unknown>
      expect(account.providerId).toBe('workbuddycn')
      // projection must be credential-free
      expect(JSON.stringify(account)).not.toMatch(/access_token|refresh_token|fake-access|password|secret/i)
    })

    it('enable/disable require a boolean body and report accepted', async () => {
      await h.request('POST', '/v1/accounts', { accountId: 'wbcn-en', loginMode: 'external-link' })
      const noBody = await h.request('POST', '/v1/accounts/wbcn-en/enable', {})
      expect(noBody.status).toBe(422)

      const dis = await h.request('POST', '/v1/accounts/wbcn-en/disable', { enabled: false })
      expect(dis.status).toBe(200)
      expect(await dis.json()).toMatchObject({ accountId: 'wbcn-en', accepted: true, status: 'disabled' })

      const disDetail = (await (await h.request('GET', '/v1/accounts/wbcn-en')).json()).account as Record<string, unknown>
      expect(disDetail.status).toBe('disabled')

      const en = await h.request('POST', '/v1/accounts/wbcn-en/enable', { enabled: true })
      expect(en.status).toBe(200)
    })

    it('unknown account detail → 404 TERMINAL', async () => {
      const res = await h.request('GET', '/v1/accounts/nope')
      expect(res.status).toBe(404)
      expect((await res.json()).error).toMatchObject({ kind: 'TERMINAL' })
    })
  })

  // Domain 5 — Quota
  describe('Domain 5: quota', () => {
    it('returns a QuotaSnapshotV1 with a credits resource', async () => {
      const accountId = await login(h)
      const res = await h.request('GET', `/v1/accounts/${accountId}/quota`)
      expect(res.status).toBe(200)
      const q = await res.json()
      expect(q.accountId).toBe(accountId)
      expect(typeof q.checkedAt).toBe('string')
      expect(['authoritative', 'cached', 'estimate']).toContain(q.source)
      const resources = q.resources as Array<Record<string, unknown>>
      expect(resources.length).toBeGreaterThan(0)
      const credits = resources.find((r) => r.kind === 'credits')
      expect(credits).toBeDefined()
      expect(credits!.unit).toBe('credits')
      expect(['ok', 'low', 'exhausted', 'reset_pending', 'unclaimable', 'unknown']).toContain(credits!.status)
      expect(typeof credits!.remaining).toBe('number')
    })

    it('quota for an unknown account → 404', async () => {
      const res = await h.request('GET', '/v1/accounts/nope/quota')
      expect(res.status).toBe(404)
    })
  })

  // Domain 6 — Chat
  describe('Domain 6: chat (non-streaming)', () => {
    it('uses the Core-supplied accountId and returns ChatResult', async () => {
      const accountId = await login(h)
      const res = await h.request('POST', '/v1/chat', {
        accountId,
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        requestId: 'req_test_1',
        deadlineMs: Date.now() + 30_000,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(typeof body.content).toBe('string')
      expect(String(body.content)).toContain('Hello World')
      expect(typeof body.finishReason).toBe('string')
    })

    it('does not select an account itself: missing accountId is rejected', async () => {
      const res = await h.request('POST', '/v1/chat', { model: 'deepseek-v4-flash', messages: [], stream: false })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatchObject({ kind: 'TERMINAL' })
    })

    it('rejects a provider-prefixed model id', async () => {
      const accountId = await login(h)
      const res = await h.request('POST', '/v1/chat', {
        accountId, model: 'workbuddycn::deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }],
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatchObject({ kind: 'PROTOCOL_VIOLATION' })
    })
  })

  // Domain 7 — Streaming
  describe('Domain 7: streaming', () => {
    it('emits chunk frames then exactly one done frame', async () => {
      const accountId = await login(h)
      const res = await h.chatStream({
        accountId, model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }],
        requestId: 'req_stream_1', deadlineMs: Date.now() + 30_000,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
      const frames = parseSse(await res.text())
      const terminals = frames.filter((f) => f.event === 'done' || f.event === 'error')
      expect(terminals).toHaveLength(1)
      expect(terminals[0]!.event).toBe('done')
      const chunks = frames.filter((f) => f.event === 'chunk')
      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.every((f) => typeof f.data.text === 'string')).toBe(true)
      expect(chunks.map((f) => f.data.text).join('')).toContain('Hello World')
    })
  })

  // Domain 8 — Errors
  describe('Domain 8: structured errors', () => {
    it('unknown route → 404 TERMINAL', async () => {
      const res = await h.request('GET', '/v1/nope')
      expect(res.status).toBe(404)
      expect((await res.json()).error).toMatchObject({ kind: 'TERMINAL' })
    })

    it('undeclared action → 404 TERMINAL', async () => {
      const res = await h.request('POST', '/v1/actions/submit-auth-code', { payload: {} })
      expect(res.status).toBe(404)
      expect((await res.json()).error).toMatchObject({ kind: 'TERMINAL' })
    })
  })

  // Domain 9 — Manual actions
  describe('Domain 9: manual actions', () => {
    it('declares exactly one read-only action; undeclared actions are 404', async () => {
      const providers = MANIFEST.providers
      expect((providers[0]!.actions ?? []).map((a) => a.id)).toEqual(['refresh-quota'])
      const res = await h.request('POST', '/v1/actions/auth-start', {})
      expect(res.status).toBe(404)
    })

    it('claim: outcome contract on the well-known claim path', async () => {
      const id = await login(h)
      // inactive activity by default in the fake upstream → not_available, no claim call
      const res = await h.request('POST', `/v1/accounts/${id}/claim`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(Object.keys(body)).toEqual(['outcome'])
      expect((body.outcome as Record<string, unknown>).kind).toBe('not_available')
      expect(h.fake.checkinClaimCalls).toBe(0)
    })
  })

  // Domain 11 — Security / auth
  describe('Domain 11: security', () => {
    it('rejects a missing token when configured', async () => {
      await h.close()
      h = await startHarness({ authToken: 'super-secret' })
      const res = await h.request('GET', '/manifest', undefined, { token: null })
      expect(res.status).toBe(401)
      expect((await res.json()).error).toMatchObject({ kind: 'AUTH_INVALID' })
    })

    it('accepts the correct token', async () => {
      await h.close()
      h = await startHarness({ authToken: 'super-secret' })
      const res = await h.request('GET', '/manifest', undefined, { token: 'super-secret' })
      expect(res.status).toBe(200)
    })

    it('never leaks credentials through any protocol response', async () => {
      await login(h)
      for (const path of ['/v1/accounts', '/v1/models', '/manifest', '/health']) {
        const text = await (await h.request('GET', path)).text()
        expect(text).not.toMatch(/fake-access|fake-refresh|access_token"\s*:|refresh_token"\s*:|password|"authorization"/i)
      }
    })
  })
})

/** Log in a fresh fake account through the protocol and return its id. */
async function login(h: HarnessResult): Promise<string> {
  const id = `wbcn-${Math.random().toString(36).slice(2, 8)}`
  const start = await h.request('POST', '/v1/accounts', { accountId: id, loginMode: 'external-link' })
  expect(start.status).toBe(201)
  h.fake.behaviour.tokenReadyAfterPolls = 1
  for (let i = 0; i < 20; i++) {
    const detail = await h.request('GET', `/v1/accounts/${id}`)
    const status = ((await detail.json()).account as Record<string, unknown>).status
    if (status === 'active') return id
  }
  throw new Error('login did not complete')
}
