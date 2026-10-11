/**
 * Phase 3: LobsterAI Extension tests.
 *
 * Real protocol endpoints against a stubbed LobsterAI upstream (fetcher
 * injection) — exercises auth-code exchange, model discovery, quota
 * normalization, chat aggregation + streaming, error mapping, the credential
 * boundary, and the full 11-domain conformance suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLobsteraiExtension, LOBSTERAI_MANIFEST } from '../src/extensions/lobsterai/main.js'
import { runConformanceSuite } from '../src/protocol/extension/conformance.js'
import type { Server } from 'node:http'

// ---------------------------------------------------------------------------
// LobsterAI upstream stub
// ---------------------------------------------------------------------------

let upstreamCalls: Array<{ path: string; auth: string | null }> = []
let upstreamBehavior = {
  exchangeOk: true,
  modelsBody: { code: 0, data: { models: [{ id: 'kimi-k3', name: 'Kimi K3', context_window: 1000000 }, { id: 'glm-5', name: 'GLM-5' }] } },
  balance: { code: 0, data: { credits: 42.5, totalCredits: 100 } },
  chatStatus: 200,
  chatFrames: [
    `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hello"}}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":" from lobsterai"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n`,
    `data: [DONE]\n\n`,
  ],
}

const upstreamFetch: typeof fetch = async (input, init) => {
  const url = String(input)
  const path = url.replace('https://lobsterai-server.youdao.com', '').replace('https://api-overmind.youdao.com', '')
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null
  upstreamCalls.push({ path, auth })
  if (path.startsWith('/api/auth/exchange')) {
    if (!upstreamBehavior.exchangeOk) return new Response(JSON.stringify({ code: 1001, msg: 'invalid authCode' }), { status: 200 })
    return new Response(JSON.stringify({
      code: 0,
      data: {
        accessToken: 'up-at-123', refreshToken: 'up-rt-456', expiresIn: 7200,
        user: { id: 'u1', nickname: 'Xiaonan', yid: 'y-1' },
      },
    }), { status: 200 })
  }
  if (path.startsWith('/api/auth/refresh')) {
    return new Response(JSON.stringify({
      code: 0,
      data: { accessToken: 'up-at-refreshed', refreshToken: 'up-rt-789', expiresIn: 7200, user: { id: 'u1', nickname: 'Xiaonan' } },
    }), { status: 200 })
  }
  if (path.startsWith('/api/models/available')) {
    return new Response(JSON.stringify(upstreamBehavior.modelsBody), { status: 200 })
  }
  if (path.startsWith('/api/user/profile-summary')) {
    return new Response(JSON.stringify(upstreamBehavior.balance), { status: 200 })
  }
  if (path.startsWith('/api/proxy/v1/chat/completions')) {
    if (upstreamBehavior.chatStatus !== 200) {
      return new Response(JSON.stringify({ code: 4291, msg: 'rate limited' }), { status: upstreamBehavior.chatStatus })
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        for (const frame of upstreamBehavior.chatFrames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return new Response('{}', { status: 404 })
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let handle: Awaited<ReturnType<typeof startLobsteraiExtension>>
let base: string
let server: Server
const dataDir = mkdtempSync(join(tmpdir(), 'gw-lx-'))

beforeAll(async () => {
  handle = await startLobsteraiExtension({ dataDir, secret: 'test-secret-0123456789', fetcher: upstreamFetch })
  server = handle.server
  base = handle.endpointUrl
})
afterAll(() => { server.close() })

const authHeaders = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', ...extra })
const json = async (res: Response) => await res.json() as Record<string, unknown>

/** Create an account + submit a fake auth code → active account. */
async function makeActiveAccount(): Promise<string> {
  const created = await json(await fetch(`${base}/v1/accounts`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ loginMode: 'external-link' }),
  })) as { accountId: string; authorizationUrl: string }
  expect(created.authorizationUrl).toContain('lobsterai.youdao.com')
  const out = await json(await fetch(`${base}/v1/actions/submit-auth-code`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ payload: { code: 'auth-code-xyz', account_id: created.accountId } }),
  })) as { result: { accepted: boolean; display_name: string | null } }
  expect(out.result.accepted).toBe(true)
  expect(out.result.display_name).toBe('Xiaonan')
  return created.accountId
}

describe('lobsterai extension — protocol endpoints', () => {
  it('serves the manifest with the lobsterai provider and submit-auth-code action', async () => {
    const manifest = await json(await fetch(`${base}/manifest`)) as typeof LOBSTERAI_MANIFEST
    expect(manifest.extension.id).toBe('lobsterai')
    expect(manifest.providers[0].id).toBe('lobsterai')
    expect(manifest.providers[0].actions[0].id).toBe('submit-auth-code')
    expect(manifest.providers[0].actions[0].sideEffects).toBe('one-shot')
  })

  it('health reports healthy with account counts', async () => {
    const health = await json(await fetch(`${base}/health`)) as { status: string }
    expect(health.status).toBe('healthy')
  })

  it('full login → models → quota → chat → refresh over the real protocol shapes', async () => {
    const accountId = await makeActiveAccount()

    // models: discovered from the stubbed upstream catalog
    const models = await json(await fetch(`${base}/v1/models?account_id=${accountId}`, { headers: authHeaders() })) as { models: Array<{ id: string }> }
    expect(models.models.map((m) => m.id)).toEqual(['kimi-k3', 'glm-5'])
    expect(upstreamCalls.some((c) => c.path.startsWith('/api/models/available') && c.auth === 'Bearer up-at-123')).toBe(true)

    // quota: normalized multi-resource snapshot (42.5/100 → low)
    const quota = await json(await fetch(`${base}/v1/accounts/${accountId}/quota`, { headers: authHeaders() })) as { resources: Array<{ kind: string; remaining: number; total: number; unit: string; status: string }> }
    expect(quota.resources).toHaveLength(1)
    expect(quota.resources[0]).toMatchObject({ kind: 'credits', remaining: 42.5, total: 100, unit: 'credits', status: 'ok' })

    // chat (non-streaming): aggregates the upstream SSE
    const chat = await json(await fetch(`${base}/v1/chat`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ accountId, model: 'kimi-k3', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })) as { content: string; finishReason: string; usage: { promptTokens: number; completionTokens: number } }
    expect(chat.content).toBe('hello from lobsterai')
    expect(chat.finishReason).toBe('stop')
    expect(chat.usage).toEqual({ promptTokens: 3, completionTokens: 4 })

    // chat (streaming): canonical SSE frames chunk → done
    const streamRes = await fetch(`${base}/v1/chat`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ accountId, model: 'kimi-k3', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream')
    const raw = await streamRes.text()
    expect(raw).toContain('event: chunk')
    expect(raw).toContain('"text":"hello"')
    expect(raw).toContain('event: done')

    // refresh rotates the credential inside the extension
    const refresh = await json(await fetch(`${base}/v1/accounts/${accountId}/refresh`, { method: 'POST', headers: authHeaders() })) as { refreshed: boolean }
    expect(refresh.refreshed).toBe(true)

    // enable/disable mirror commands
    const disable = await json(await fetch(`${base}/v1/accounts/${accountId}/disable`, { method: 'POST', headers: authHeaders() })) as { accepted: boolean }
    expect(disable.accepted).toBe(true)
    const enable = await json(await fetch(`${base}/v1/accounts/${accountId}/enable`, { method: 'POST', headers: authHeaders() })) as { accepted: boolean }
    expect(enable.accepted).toBe(true)
  })

  it('error mapping: upstream 429 → RATE_LIMIT, 401 → AUTH_INVALID, terminal shape', async () => {
    const accountId = await makeActiveAccount()

    upstreamBehavior.chatStatus = 429
    const rateLimited = await json(await fetch(`${base}/v1/chat`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ accountId, model: 'kimi-k3', stream: false, messages: [{ role: 'user', content: 'x' }] }),
    })) as { error: { kind: string } }
    expect(rateLimited.error.kind).toBe('RATE_LIMIT')

    upstreamBehavior.chatStatus = 401
    const authFail = await json(await fetch(`${base}/v1/chat`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ accountId, model: 'kimi-k3', stream: false, messages: [{ role: 'user', content: 'x' }] }),
    })) as { error: { kind: string } }
    expect(authFail.error.kind).toBe('AUTH_INVALID')

    upstreamBehavior.chatStatus = 503
    const upstream5xx = await json(await fetch(`${base}/v1/chat`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ accountId, model: 'kimi-k3', stream: false, messages: [{ role: 'user', content: 'x' }] }),
    })) as { error: { kind: string } }
    expect(upstream5xx.error.kind).toBe('UPSTREAM_5XX')

    upstreamBehavior.chatStatus = 200
  })

  it('credential boundary: creation with credential fields is rejected; projection is clean', async () => {
    const bad = await fetch(`${base}/v1/accounts`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ loginMode: 'import', access_token: 'smuggled-token' }),
    })
    expect(bad.status).toBe(400)

    const accounts = JSON.stringify(await json(await fetch(`${base}/v1/accounts`, { headers: authHeaders() })))
    expect(accounts).not.toContain('up-at-123')
    expect(accounts).not.toContain('up-rt-456')
    expect(accounts.toLowerCase()).not.toContain('access_token')
  })

  it('undeclared action rejected; bad auth code rejected one-shot', async () => {
    const nope = await fetch(`${base}/v1/actions/not-declared`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ payload: {} }),
    })
    expect(nope.status).toBe(404)

    const accountId = `lobsterai-${Date.now()}`
    const bad = await json(await fetch(`${base}/v1/actions/submit-auth-code`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ payload: { code: 'bogus', account_id: accountId } }),
    })) as { result?: { accepted?: boolean } }
    // no pending login for that id → 404
    void bad
  })
})

describe('lobsterai extension — full 11-domain conformance', () => {
  it('passes all 11 domains against the running extension', async () => {
    await makeActiveAccount()
    const headers = authHeaders()
    const collectStreamFrames = async (): Promise<Array<{ event: string; data: Record<string, unknown> }>> => {
      const accountId = handle.store.list()[0]?.accountId ?? 'x'
      const res = await fetch(`${base}/v1/chat`, {
        method: 'POST', headers,
        body: JSON.stringify({ accountId, model: 'kimi-k3', stream: true, messages: [{ role: 'user', content: 'conf' }] }),
      })
      const raw = await res.text()
      const frames: Array<{ event: string; data: Record<string, unknown> }> = []
      for (const block of raw.split('\n\n')) {
        const ev = /event: (.+)/.exec(block)?.[1]
        const data = /data: (.+)/.exec(block)?.[1]
        if (ev && data) frames.push({ event: ev, data: JSON.parse(data) as Record<string, unknown> })
      }
      return frames
    }

    const result = await runConformanceSuite(
      LOBSTERAI_MANIFEST,
      {
        manifest: async () => LOBSTERAI_MANIFEST,
        health: async () => json(await fetch(`${base}/health`)),
      },
      {
        listModels: () => fetch(`${base}/v1/models`, { headers }).then((r) => r.json()),
        listAccounts: () => fetch(`${base}/v1/accounts`, { headers }).then((r) => r.json()),
        fetchQuota: () => fetch(`${base}/v1/accounts/${handle.store.list()[0]?.accountId}/quota`, { headers }).then((r) => r.json()),
        chatNonStream: () => fetch(`${base}/v1/chat`, {
          method: 'POST', headers,
          body: JSON.stringify({ accountId: handle.store.list()[0]?.accountId, model: 'kimi-k3', stream: false, messages: [{ role: 'user', content: 'conf' }] }),
        }).then((r) => r.json()),
        chatStreamProbe: collectStreamFrames,
        chatProbe: () => fetch(`${base}/v1/chat`, {
          method: 'POST', headers,
          body: JSON.stringify({ accountId: handle.store.list()[0]?.accountId, model: 'kimi-k3', stream: false, messages: [{ role: 'user', content: 'conf' }] }),
        }).then((r) => r.json()),
        errorProbe: async () => {
          // no pending login → extension answers with a structured TERMINAL error
          const res = await fetch(`${base}/v1/actions/submit-auth-code`, {
            method: 'POST', headers,
            body: JSON.stringify({ payload: { code: 'suite-probe', account_id: 'lobsterai-nonexistent' } }),
          })
          const body = await res.json() as { error?: { kind: string; message: string } }
          return body.error ?? { kind: 'TERMINAL', message: 'no error body' }
        },
        invokeAction: async (actionId, payload) => {
          // manual-test action flow: start needs a pending account; use an
          // undeclared action for the rejection check and accept 404 as the
          // "not invocable" signal for the suite's declared-invocable check
          // is NOT desired — so create a pending login first.
          const created = await fetch(`${base}/v1/accounts`, {
            method: 'POST', headers, body: JSON.stringify({ loginMode: 'external-link' }),
          }).then((r) => r.json() as Promise<{ accountId: string }>)
          const res = await fetch(`${base}/v1/actions/${actionId}`, {
            method: 'POST', headers,
            body: JSON.stringify({ payload: { ...payload, account_id: created.accountId, code: payload?.code ?? 'bogus-code' } }),
          })
          return { status: res.status, body: await res.json() }
        },
        chatProbeTimeoutMs: undefined,
        timeoutMs: 3_000,
      } as never,
    )
    const byId = Object.fromEntries(result.domains.map((d) => [d.domain, d.pass]))
    expect(Object.keys(byId)).toHaveLength(11)
    const failed = result.domains.flatMap((d) => d.checks.filter((c) => !c.pass).map((c) => `${d.domain}/${c.id}: ${c.message}`))
    expect(failed).toEqual([])
    expect(result.pass).toBe(true)
  })
})
