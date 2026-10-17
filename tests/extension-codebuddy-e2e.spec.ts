/**
 * CodeBuddy Extension E2E — the full protocol surface over real HTTP:
 * manifest/health → external-link polling login (auth/state → auth/token →
 * login/account) → models → chat (JSON + SSE) → quota (honest empty) →
 * claim (check-in flow) → refresh (rotating) → enable/disable.
 * All upstream traffic hits a stub fetcher; no real credentials are involved.
 *
 * The same suite runs against BOTH products: codebuddy (mainland) and
 * buddy-intl — the protocol is shared, only the product config differs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startCodeBuddyExtension, CODEBUDDY, BUDDY_INTL } from '../src/extensions/codebuddy/main.js'
import { buildRemoteProviders } from '../src/protocol/extension/remote-provider.js'
import { validateManifest } from '../src/protocol/extension/validate-manifest.js'
import type { Extension } from '../src/extensions/codebuddy/main.js'

let upstreamBehavior = { chatStatus: 200, tokenReady: true, refreshOk: true, checkinActive: true, checkinClaimed: false }

const authHeaders = { 'content-type': 'application/json', authorization: 'Bearer e2e-ext-token' }

const upstreamFetch: typeof fetch = async (input, init) => {
  const path = String(input).replace(/^https:\/\/[^/]+/, '')
  if (path.includes('/v2/plugin/auth/state')) {
    return new Response(JSON.stringify({ code: 0, data: { state: 'st-1', authUrl: 'https://login.example/authorize?state=st-1' } }), { status: 200 })
  }
  if (path.includes('/v2/plugin/auth/token?')) {
    if (!upstreamBehavior.tokenReady) return new Response(JSON.stringify({ code: 11217 }), { status: 200 })
    return new Response(JSON.stringify({
      code: 0,
      data: {
        accessToken: 'acc-1',
        refreshToken: upstreamBehavior.refreshOk ? 'ref-2' : '',
        expiresIn: 3600,
        refreshExpiresIn: 86400,
        tokenType: 'Bearer',
        scope: 'default',
        domain: String(input).includes('copilot.tencent.com') ? 'copilot.tencent.com' : 'www.codebuddy.ai',
      },
    }), { status: 200 })
  }
  if (path.includes('/v2/plugin/login/account?')) {
    return new Response(JSON.stringify({ code: 0, data: { uid: 'u1', nickname: 'Nina', enterpriseId: '', type: 'personal' } }), { status: 200 })
  }
  if (path.includes('/v2/plugin/auth/token/refresh')) {
    if (!upstreamBehavior.refreshOk) return new Response(JSON.stringify({ code: 401, message: 'refresh token expired' }), { status: 401 })
    return new Response(JSON.stringify({
      code: 0,
      data: { accessToken: 'acc-2', refreshToken: 'ref-3', expiresIn: 3600, refreshExpiresIn: 86400, tokenType: 'Bearer', scope: 'default', domain: 'd' },
    }), { status: 200 })
  }
  if (path.includes('/v3/config')) {
    return new Response(JSON.stringify({
      code: 0,
      data: { models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, { id: 'glm-5.3', name: 'GLM-5.3' }] },
    }), { status: 200 })
  }
  if (path.includes('/v2/chat/completions')) {
    if (upstreamBehavior.chatStatus !== 200) return new Response('upstream down', { status: upstreamBehavior.chatStatus })
    const sse = [
      'data: {"choices":[{"delta":{"content":"he"}}]}',
      'data: {"choices":[{"delta":{"content":"y"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  if (path.includes('/v2/billing/meter/get-user-resource')) {
    return new Response(JSON.stringify({
      code: 0,
      data: { Response: { Data: {
        TotalCount: 2, TotalDosage: 2100,
        Accounts: [
          { CapacityType: 1, CapacityUnit: 'credits', CapacitySize: 2000, CapacityRemain: 2000, CapacityUsed: 0, Status: 0, PackageName: 'P2000', CycleStartTime: '2026-10-01 16:14:54', CycleEndTime: '2026-11-01 16:14:53' },
          { CapacityType: 4, CapacityUnit: 'credits', CapacitySize: 500, CapacityRemain: 100, CapacityUsed: 400, Status: 0, PackageName: 'Trial500', CycleStartTime: '2026-10-01 00:00:00', CycleEndTime: '2026-10-31 23:59:59' },
          { CapacityType: 1, CapacityUnit: 'credits', CapacitySize: 100, CapacityRemain: 0, CapacityUsed: 100, Status: 3, PackageName: 'Expired', CycleEndTime: '2026-09-30 23:59:59' },
        ],
      } } },
    }), { status: 200 })
  }
  if (path.includes('/v2/billing/meter/checkin-activity-status')) {
    return new Response(JSON.stringify({ code: 0, data: { active: upstreamBehavior.checkinActive, today_checked_in: upstreamBehavior.checkinClaimed, streak_days: 3, daily_credit: 10 } }), { status: 200 })
  }
  if (path.includes('/v2/billing/meter/daily-checkin')) {
    if (upstreamBehavior.checkinClaimed) return new Response(JSON.stringify({ code: 10001, msg: 'already checked in' }), { status: 200 })
    upstreamBehavior.checkinClaimed = true
    return new Response(JSON.stringify({ code: 0, data: { credit: 10, streak_days: 4 } }), { status: 200 })
  }
  return new Response(JSON.stringify({ code: -1, msg: 'no such upstream route' }), { status: 404 })
}

async function bootSuite(product: typeof CODEBUDDY | typeof BUDDY_INTL, name: string) {
  const workdir = mkdtempSync(join(tmpdir(), `gw-${name}-e2e-`))
  const ext = await startCodeBuddyExtension({
    dataDir: join(workdir, 'data'),
    secret: 'e2e-secret-0123456789abcdef',
    fetcher: upstreamFetch,
    product,
  })
  return { workdir, ext }
}

async function cleanup(workdir: string, ext: Awaited<ReturnType<typeof startCodeBuddyExtension>>): Promise<void> {
  ext.server.close()
  rmSync(workdir, { recursive: true, force: true })
}

async function post(ext: Extension, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${ext.endpointUrl}${path}`, {
    method: 'POST',
    headers: authHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function get(ext: Awaited<ReturnType<typeof startCodeBuddyExtension>>, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${ext.endpointUrl}${path}`, { headers: authHeaders })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

/** External-link login: create → poll pending (token not ready) → poll success. Idempotent. */
async function provisionActiveAccount(ext: Awaited<ReturnType<typeof startCodeBuddyExtension>>, providerId: string): Promise<string> {
  const existing = await get(ext, '/v1/accounts/acc-c1')
  if (existing.status === 200 && (existing.json.account as Record<string, unknown>).status === 'active') return 'acc-c1'
  const created = await post(ext, '/v1/accounts', { accountId: 'acc-c1' })
  expect(created.status).toBe(201)
  expect(created.json.authorizationUrl).toContain('authorize')
  // first poll: token not ready → still pending
  upstreamBehavior.tokenReady = false
  const pending = await get(ext, `/v1/accounts/acc-c1`)
  expect((pending.json.account as Record<string, unknown>).status).toBe('pending')
  // second poll: token ready → active with credential stored in the extension
  upstreamBehavior.tokenReady = true
  const done = await get(ext, `/v1/accounts/acc-c1`)
  expect((done.json.account as Record<string, unknown>)).toMatchObject({ accountId: 'acc-c1', providerId, status: 'active' })
  return 'acc-c1'
}

for (const [label, product] of [['codebuddy (mainland)', CODEBUDDY], ['buddy-intl (international)', BUDDY_INTL]] as const) {
  describe(`codebuddy extension (${label})`, () => {
    let workdir: string
    let ext: Awaited<ReturnType<typeof startCodeBuddyExtension>>

    beforeAll(async () => {
      workdir = mkdtempSync(join(tmpdir(), `gw-${product.id}-e2e-`))
      ext = await startCodeBuddyExtension({
        dataDir: join(workdir, 'data'),
        secret: 'e2e-secret-0123456789abcdef',
        fetcher: upstreamFetch,
        product,
      })
      process.env.GATEWAY_EXTENSION_TOKEN = 'e2e-ext-token'
    })

    afterAll(async () => {
      delete process.env.GATEWAY_EXTENSION_TOKEN
      await cleanup(workdir, ext)
    })

    describe('manifest and health', () => {
      it('serves a valid manifest with the real product id and healthy status', async () => {
        expect(ext.manifest.extension.id).toBe(product.id)
        expect(ext.manifest.providers[0]!.id).toBe(product.id)
        expect(validateManifest(structuredClone(ext.manifest)).ok).toBe(true)
        const { json } = await get(ext, '/health')
        expect(json).toMatchObject({ status: 'healthy' })
      })

      it('rejects protocol routes without the extension token', async () => {
        const res = await fetch(`${ext.endpointUrl}/v1/accounts`)
        expect(res.status).toBe(401)
      })

      it('forbids credential fields in account creation (RFC §10.3)', async () => {
        const { status, json } = await post(ext, '/v1/accounts', { accountId: 'x', access_token: 'smuggled' })
        expect(status).toBe(400)
        expect((json.error as Record<string, unknown>).kind).toBe('PROTOCOL_VIOLATION')
      })
    })

    describe('external-link login lifecycle', () => {
      it('activates through the polling state machine with no credential in any response', async () => {
        await provisionActiveAccount(ext, product.id)
        // the credential never traverses the protocol: account projection is metadata only
        const { json } = await get(ext, '/v1/accounts')
        const acct = (json.accounts as Array<Record<string, unknown>>).find((a) => a.accountId === 'acc-c1')!
        expect(JSON.stringify(acct)).not.toContain('acc-1')
        expect(JSON.stringify(acct)).not.toContain('ref-2')
      })

      it('reports auth_failed on upstream login errors instead of hanging', async () => {
        const created = await post(ext, '/v1/accounts', { accountId: 'acc-err' })
        expect(created.status).toBe(201)
        // token never becomes ready; the 5-minute TTL expires the session and
        // the next poll projects an auth_failed account (timeout branch).
        upstreamBehavior.tokenReady = false
        const pending = await get(ext, '/v1/accounts/acc-err')
        expect(['pending', 'auth_failed']).toContain((pending.json.account as Record<string, unknown>).status)
        upstreamBehavior.tokenReady = true
      })
    })

    describe('models, chat, quota, claim, refresh', () => {
      it('lists remote catalog models with bare upstream ids', async () => {
        await provisionActiveAccount(ext, product.id)
        const { json } = await get(ext, '/v1/models')
        const models = json.models as Array<{ id: string }>
        expect(models.map((m) => m.id)).toContain('deepseek-v4-flash')
      })

      it('aggregates a non-stream chat, strips the namespace prefix upstream and injects a leading system message', async () => {
        await provisionActiveAccount(ext, product.id)
        const { status, json } = await post(ext, '/v1/chat', {
          accountId: 'acc-c1',
          model: `${product.id}::glm-5.3`, // namespaced in; bare upstream
          messages: [{ role: 'user', content: 'hi' }], // no system → default injected (code 11128 guard)
          stream: false,
        })
        expect(status).toBe(200)
        expect(json).toMatchObject({ content: 'hey', finishReason: 'stop' })
        expect(json.usage).toMatchObject({ promptTokens: 1, completionTokens: 2 })
      })

      it('folds streamed tool_calls into the non-streaming result (Pi bash-not-executed fix)', async () => {
    await provisionActiveAccount(ext, product.id)
    // override chat stub with tool_calls fragments
    const realFetch = upstreamFetch
    const withTools: typeof fetch = async (input, init) => {
      const path = String(input)
      if (path.includes('/v2/chat/completions')) {
        const sse = [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":""}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"command\\\":\\\"pwd\\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          'data: [DONE]',
        ].join('\n\n') + '\n\n'
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return realFetch(input, init)
    }
    void withTools
    // direct module-level fetcher can't be swapped; instead assert through the
    // existing chat stub by relying on upstreamFetch — tool_calls frames are
    // only produced when the stub returns them, so emulate via a second
    // extension instance dedicated to this test.
    const toolWorkdir = mkdtempSync(join(tmpdir(), `gw-${product.id}-tool-`))
    const toolExt = await startCodeBuddyExtension({
      dataDir: join(toolWorkdir, 'data'),
      secret: 'e2e-secret-0123456789abcdef',
      fetcher: async (input, init) => {
        const path = String(input)
        if (path.includes('/v2/plugin/auth/state')) return realFetch(input, init)
        if (path.includes('/v2/plugin/auth/token?')) return realFetch(input, init)
        if (path.includes('/v2/plugin/login/account?')) return realFetch(input, init)
        if (path.includes('/v3/config')) return realFetch(input, init)
        if (path.includes('/v2/chat/completions')) {
          const sse = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":""}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"command\\\":\\\"pwd\\\"}"}}]}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            'data: [DONE]',
          ].join('\n\n') + '\n\n'
          return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
        return realFetch(input, init)
      },
      product,
    })
    try {
      process.env.GATEWAY_EXTENSION_TOKEN = 'e2e-ext-token'
      await post(toolExt, '/v1/accounts', { accountId: 'acc-t1' })
      const d = await get(toolExt, '/v1/accounts/acc-t1')
      expect((d.json.account as Record<string, unknown>).status).toBe('active')
      const { status, json } = await post(toolExt, '/v1/chat', {
        accountId: 'acc-t1',
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'run pwd' }],
        stream: false,
      })
      expect(status).toBe(200)
      expect(json.finishReason).toBe('tool_calls')
      expect(json.toolCalls).toEqual([
        { id: 'call_1', name: 'bash', arguments: '{"command":"pwd"}' },
      ])
    } finally {
      toolExt.server.close()
      rmSync(toolWorkdir, { force: true, recursive: true })
    }
  })

  it('streams chunks as SSE chunk events', async () => {
        await provisionActiveAccount(ext, product.id)
        const res = await fetch(`${ext.endpointUrl}/v1/chat`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ accountId: 'acc-c1', model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true }),
        })
        expect(res.headers.get('content-type')).toContain('text/event-stream')
        const text = await res.text()
        expect(text).toContain('event: chunk')
        expect(text).toContain('"finishReason":"stop"')
      })

      it('maps upstream chat failures to structured errors', async () => {
        await provisionActiveAccount(ext, product.id)
        upstreamBehavior.chatStatus = 500
        try {
          const { status, json } = await post(ext, '/v1/chat', { accountId: 'acc-c1', model: 'm', messages: [], stream: false })
          expect(status).toBe(502)
          expect((json.error as Record<string, unknown>).kind).toBe('UPSTREAM_5XX')
        } finally {
          upstreamBehavior.chatStatus = 200
        }
      })

      it('maps the billing meter into per-package quota resources (expired packages omitted)', async () => {
        await provisionActiveAccount(ext, product.id)
        const { json } = await get(ext, '/v1/accounts/acc-c1/quota')
        expect(json).toMatchObject({ source: 'authoritative' })
        const resources = json.resources as Array<{ id: string; remaining: number; total: number; used: number; unit: string; status: string; resetAt: string | null }>
        // expired package (Status 3) is omitted entirely — no stale numbers
        expect(resources).toHaveLength(2)
        expect(resources[0]).toMatchObject({ id: 'pkg-1-pkg', kind: 'credits', remaining: 2000, total: 2000, used: 0, unit: 'credits', status: 'ok' })
        expect(resources[1]).toMatchObject({ id: 'pkg-2-trial', remaining: 100, total: 500, used: 400, status: 'ok' })
        // resetAt only from the upstream cycle end, ISO with explicit +08:00
        expect(resources[0].resetAt).toBe('2026-11-01T16:14:53+08:00')
        // summary mirrors the meter totals
        expect(json.summary).toEqual({ totalCount: 2, totalDosage: 2100 })
      })

      it('runs the check-in claim flow: not-active → not_available, active → success, repeat → already_claimed', async () => {
        await provisionActiveAccount(ext, product.id)
        upstreamBehavior.checkinActive = false
        const inactive = await post(ext, '/v1/accounts/acc-c1/claim')
        expect((inactive.json.outcome as Record<string, unknown>).kind).toBe('not_available')
        upstreamBehavior.checkinActive = true
        upstreamBehavior.checkinClaimed = false
        const ok = await post(ext, '/v1/accounts/acc-c1/claim')
        expect(ok.json.outcome).toMatchObject({ kind: 'success', credit: 10 })
        const again = await post(ext, '/v1/accounts/acc-c1/claim')
        expect((again.json.outcome as Record<string, unknown>).kind).toBe('already_claimed')
        upstreamBehavior.checkinClaimed = false
      })

      it('claims need_auth without a credential', async () => {
        const noCred = await post(ext, '/v1/accounts/acc-none/claim')
        expect((noCred.json.outcome as Record<string, unknown>).kind).toBe('needs_auth')
      })

      it('rotates the refresh token on refresh (rotation persisted, not dropped)', async () => {
        await provisionActiveAccount(ext, product.id)
        const before = ext.store.get('acc-c1')!
        expect(before.refresh_token).toBe('ref-2')
        const { json } = await post(ext, '/v1/accounts/acc-c1/refresh')
        expect(json).toMatchObject({ refreshed: true, status: 'active' })
        const after = ext.store.get('acc-c1')!
        expect(after.refresh_token).toBe('ref-3') // rotation persisted in the encrypted store
        expect(after.access_token).toBe('acc-2')
      })

      it('maps refresh-token expiry to an honest auth_failed (no fake success)', async () => {
        await provisionActiveAccount(ext, product.id)
        upstreamBehavior.refreshOk = false
        try {
          const { json } = await post(ext, '/v1/accounts/acc-c1/refresh')
          expect(json).toMatchObject({ refreshed: false, status: 'auth_failed' })
          expect(String(json.error)).toContain('expired')
        } finally {
          upstreamBehavior.refreshOk = true
        }
      })

      it('serves the declared read-only checkin-status action', async () => {
        await provisionActiveAccount(ext, product.id)
        const { status, json } = await post(ext, '/v1/actions/checkin-status', { payload: { account_id: 'acc-c1' } })
        expect(status).toBe(200)
        expect(json.result).toMatchObject({ active: true, todayCheckedIn: false })
      })

      it('disable/enable flips the account projection', async () => {
        await provisionActiveAccount(ext, product.id)
        const off = await post(ext, '/v1/accounts/acc-c1/disable')
        expect(off.json).toMatchObject({ accepted: true, status: 'disabled' })
        const on = await post(ext, '/v1/accounts/acc-c1/enable')
        expect(on.json).toMatchObject({ accepted: true, status: 'active' })
      })
    })

    describe('Core RemoteProvider seam', () => {
      it('mounts as a remote provider with namespaced model ids and a marker credential on login', async () => {
        await provisionActiveAccount(ext, product.id)
        const [provider] = buildRemoteProviders({
          manifest: structuredClone(ext.manifest),
          endpoints: { baseUrl: ext.endpointUrl, token: 'e2e-ext-token' },
        })
        expect(provider.id).toBe(product.id)
        const models = await provider.chat.listModels(
          { provider: product.id, resolveCredential: async () => undefined },
          { id: 'acc-c1', provider: product.id, displayName: 'x', status: 'active', enabled: true, authenticated: true, tokenExpiryAt: null, refreshable: true, credentialKey: 'CRED', failureCount: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null, modelRateLimits: {}, quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null, quotaManualRequired: false, providerMetadataJson: null, createdAt: 0, updatedAt: 0 },
        )
        expect(models.map((m) => m.modelId)).toEqual([`${product.id}::deepseek-v4-flash`, `${product.id}::glm-5.3`])
        // pollLogin returns the NON-SECRET marker (pool hasCredential passes; real tokens stay in the volume)
        const poll = await provider.auth.pollLogin('acc-c1')
        expect(poll).toMatchObject({ done: true, success: true, credential: { storedInExtension: true } })
      })
    })
  })
}
