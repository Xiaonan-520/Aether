/**
 * TRAE provider contracts: deterministic device-identity derivation (ported
 * exact, so a drift would change the device identity), the OpenAI → SOLO body
 * transform, SOLO SSE → ChatChunk mapping, model filtering, refresh rotation
 * with per-account identity isolation, quota and check-in gating.
 */
import { describe, expect, it } from 'vitest'
import {
  TRAE,
  TRAE_INTL,
  ALL_TRAE_PRODUCTS,
  TRAE_BATCH_MODELS_PATH,
  TRAE_CHAT_PATH,
  TRAE_CHECKIN_CLAIM_PATH,
  TRAE_CHECKIN_STATUS_PATH,
  TRAE_ENT_USAGE_PATH,
  TRAE_EXCHANGE_PATH,
} from '../src/providers/trae/product.js'
import {
  deriveDeviceId15,
  deriveMarketUserId,
  deriveSessionId,
  newTraeDeviceIdentity,
  parseTraeBatchModelList,
  parseTraeSoloEvents,
  transformToSOLOBody,
  traeCheckinHeaders,
  traeSOLOHeaders,
} from '../src/providers/trae/protocol.js'
import { createTraeProvider } from '../src/providers/trae/provider.js'
import type { Account } from '../src/core/types.js'
import type { ProviderCtx } from '../src/core/registry/provider.js'

function account(id = 'trae-a1'): Account {
  return {
    id, provider: 'trae', displayName: id, status: 'active', enabled: true, authenticated: true,
    tokenExpiryAt: null, refreshable: true, credentialKey: `CRED_${id}`, failureCount: 0,
    lastSuccessAt: null, lastFailureAt: null, lastError: null, cooldownUntil: null, modelRateLimits: {},
    quotaJson: null, lastQuotaAt: null, lastCreditClaimAt: null, quotaManualRequired: false,
    providerMetadataJson: null, createdAt: 0, updatedAt: 0,
  }
}

function ctx(credential: unknown): ProviderCtx {
  return {
    provider: 'trae',
    resolveCredential: async () => ({ ref: 'r', expiresAt: null, refreshable: true, credential }),
  }
}

const CRED = {
  access_token: 'acc', refresh_token: 'ref', uid: 'u1', nickname: 'n',
  machine_id: 'a'.repeat(32), device_id: '1'.repeat(16),
}

const SOLO_SSE =
  'event:output\ndata:{"response":"po","reasoning_content":"think"}\n\n' +
  'event:output\ndata:{"response":"ng"}\n\n' +
  'event:token_usage\ndata:{"prompt_tokens":7,"completion_tokens":3}\n\n' +
  'event:done\ndata:{"finish_reason":"stop"}\n\n'

interface Route { match: string; json?: unknown; text?: string; status?: number }
function makeFetcher(routes: Route[], onCall?: (url: string, init?: RequestInit) => void) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    onCall?.(url, init)
    for (const r of routes) {
      if (!url.includes(r.match)) continue
      const status = r.status ?? 200
      if (r.text !== undefined) return new Response(r.text, { status, headers: { 'content-type': 'text/event-stream' } })
      return new Response(JSON.stringify(r.json ?? {}), { status, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

async function collect(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('trae protocol — device identity', () => {
  it('derives a stable per-user device id, market id and session id', () => {
    // deterministic: same input → same output
    expect(deriveDeviceId15('user-1')).toBe(deriveDeviceId15('user-1'))
    expect(deriveDeviceId15('user-1')).toHaveLength(15)
    expect(deriveDeviceId15('user-1')).toMatch(/^\d{15}$/)
    expect(deriveMarketUserId('user-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(deriveSessionId('user-1')).toHaveLength(64)
    // isolation: different users get different identities
    expect(deriveDeviceId15('user-1')).not.toBe(deriveDeviceId15('user-2'))
    expect(deriveMarketUserId('user-1')).not.toBe(deriveMarketUserId('user-2'))
    expect(deriveSessionId('user-1')).not.toBe(deriveSessionId('user-2'))
  })

  it('generates a fresh 32-hex machine id and 16-digit device id per account', () => {
    let n = 0
    const a = newTraeDeviceIdentity(() => (n++ % 7) / 7)
    expect(a.machine_id).toMatch(/^[0-9a-f]{32}$/)
    expect(a.device_id).toMatch(/^\d{16}$/)
  })

  it('sends the token in all three required headers plus X-Machine-Id / X-Device-Id', () => {
    const h = traeSOLOHeaders(CRED as never, TRAE, true)
    expect(h.Authorization).toBe('Cloud-IDE-JWT acc')
    expect(h['X-Cloudide-Token']).toBe('acc')
    expect(h['X-Ide-Token']).toBe('acc')
    expect(h['X-Machine-Id']).toBe('a'.repeat(32))
    expect(h['X-Device-Id']).toBe('1'.repeat(16))
    expect(h.Accept).toBe('text/event-stream')
  })

  it('derives a per-account check-in device id (not the credential device id)', () => {
    const h1 = traeCheckinHeaders(CRED as never, TRAE, 'uid-A')
    const h2 = traeCheckinHeaders(CRED as never, TRAE, 'uid-B')
    expect(h1['X-Device-Id']).toHaveLength(15)
    expect(h1['X-Device-Id']).not.toBe(h2['X-Device-Id'])
    expect(h1['X-Market-User-ID']).not.toBe(h2['X-Market-User-ID'])
    expect(h1['X-Device-Id']).not.toBe(CRED.device_id)
  })
})

describe('trae protocol — SOLO body + SSE', () => {
  it('converts OpenAI → SOLO (content parts, config_name, function, tools as JSON strings)', () => {
    const solo = transformToSOLOBody({
      model: 'glm-5.2',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      ],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      tool_choice: 'none',
    })
    expect(solo.stream).toBe(true)
    expect(solo.config_name).toBe('glm-5.2')
    expect(solo.model).toBe('glm-5.2')
    expect(solo.function).toBe('solo_work_lite')
    const msgs = solo.messages as Array<Record<string, unknown>>
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'be brief' }])
    // assistant tool_calls renamed to function_call
    expect((msgs[1].tool_calls as Array<Record<string, unknown>>)[0].function_call).toEqual({ name: 'f', arguments: '{}' })
    // tool_choice none drops tools/tool_choice
    expect(solo.tools).toBeUndefined()
    expect(solo.tool_choice).toBeUndefined()
  })

  it('serializes tool parameters to a JSON string', () => {
    const solo = transformToSOLOBody({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { a: { type: 'string' } } } } }],
    })
    const fn = (solo.tools as Array<Record<string, unknown>>)[0].function as Record<string, unknown>
    expect(typeof fn.parameters).toBe('string')
    expect(JSON.parse(fn.parameters as string)).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
  })

  it('parses SOLO SSE events and maps output/token_usage/done', async () => {
    const stream = (async function* () { yield new TextEncoder().encode(SOLO_SSE) })()
    const events = await collect(parseTraeSoloEvents(stream))
    expect(events.map((e) => (e as { event: string }).event)).toEqual(['output', 'output', 'token_usage', 'done'])
  })

  it('parses the batch model list with the required filters', () => {
    const models = parseTraeBatchModelList({
      function_configs: [
        {
          function: 'solo_work_lite',
          config_info_list: [
            { config_name: 'glm-5.2', display_name: 'GLM-5.2', usage: 'chat_completion', config_switch: true },
            { config_name: 'summary-x', usage: 'summary', config_switch: true },
            { config_name: 'off', usage: 'chat_completion', config_switch: false },
            { config_name: 'hidden', usage: 'chat_completion', config_switch: true, is_invisible_to_user: true },
          ],
        },
      ],
    }, TRAE.channels)
    expect(models.map((m) => m.id)).toEqual(['glm-5.2'])
  })
})

describe('trae adapter', () => {
  it('exposes CN and INTL as separate products with distinct hosts', () => {
    expect(ALL_TRAE_PRODUCTS.map((p) => p.id)).toEqual(['trae', 'trae-intl'])
    expect(TRAE.agentHost).not.toBe(TRAE_INTL.agentHost)
    expect(TRAE.ugHost).not.toBe(TRAE_INTL.ugHost)
  })

  it('declares credits + quota capabilities', () => {
    const p = createTraeProvider({ fetcher: makeFetcher([]) })
    expect(p.capabilities).toMatchObject({ supportsRefreshToken: true, supportsQuota: true, supportsCredits: true, protocol: 'openai-chat' })
  })

  it('aggregates a non-stream chat via SOLO SSE and keeps reasoning', async () => {
    const fetcher = makeFetcher([{ match: TRAE_CHAT_PATH, text: SOLO_SSE }])
    const p = createTraeProvider({ fetcher })
    const res = await p.chat.chat(ctx(CRED), { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: false }, account())
    expect(res.content).toBe('pong')
    expect(res.reasoning).toBe('think')
    expect(res.finishReason).toBe('stop')
    expect(res.usage).toEqual({ promptTokens: 7, completionTokens: 3 })
  })

  it('streams and sends the SOLO body with function + config_name', async () => {
    let body: Record<string, unknown> | undefined
    const fetcher = makeFetcher([{ match: TRAE_CHAT_PATH, text: SOLO_SSE }], (_u, init) => {
      if (init?.body) body = JSON.parse(String(init.body))
    })
    const p = createTraeProvider({ fetcher })
    await collect(p.chat.stream(ctx(CRED), { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true }, account()))
    expect(body?.function).toBe('solo_work_lite')
    expect(body?.config_name).toBe('glm-5.2')
  })

  it('scopes refresh to the account and returns the rotated credential with identity preserved', async () => {
    const fetcher = makeFetcher([
      { match: TRAE_EXCHANGE_PATH, json: { data: { access_token: 'new-acc', refresh_token: 'new-ref', expires_in: 3600, user: { id: 'u1' } } } },
    ])
    const p = createTraeProvider({ fetcher })
    const result = await p.ops.refreshAccount!(ctx(CRED), account())
    expect(result.refreshed).toBe(true)
    expect(result.credential).toMatchObject({ access_token: 'new-acc', refresh_token: 'new-ref', machine_id: CRED.machine_id, device_id: CRED.device_id })
  })

  it('isolates device identity per account (identity comes from each credential, never global)', async () => {
    const seen: string[] = []
    const fetcher = makeFetcher([{ match: TRAE_CHAT_PATH, text: SOLO_SSE }], (_u, init) => {
      const h = init?.headers as Record<string, string> | undefined
      if (h?.['X-Machine-Id']) seen.push(h['X-Machine-Id'])
    })
    const p = createTraeProvider({ fetcher })
    await collect(p.chat.stream(ctx({ ...CRED, machine_id: 'a'.repeat(32) }), { model: 'm', messages: [], stream: true }, account('a')))
    await collect(p.chat.stream(ctx({ ...CRED, machine_id: 'b'.repeat(32) }), { model: 'm', messages: [], stream: true }, account('b')))
    expect(seen).toEqual(['a'.repeat(32), 'b'.repeat(32)])
  })

  it('gates the check-in on status and never claims when unavailable', async () => {
    const claimCalls: string[] = []
    const disabled = createTraeProvider({
      fetcher: makeFetcher(
        [{ match: TRAE_CHECKIN_STATUS_PATH, json: { data: { enable: false, checked_in: false } } }],
        (u) => { if (u.includes(TRAE_CHECKIN_CLAIM_PATH)) claimCalls.push(u) },
      ),
    })
    expect(await disabled.ops.claimCredits!(ctx(CRED), account())).toMatchObject({ kind: 'not_available' })
    expect(claimCalls).toHaveLength(0)

    const already = createTraeProvider({
      fetcher: makeFetcher(
        [{ match: TRAE_CHECKIN_STATUS_PATH, json: { data: { enable: true, checked_in: true, credits: 100 } } }],
        (u) => { if (u.includes(TRAE_CHECKIN_CLAIM_PATH)) claimCalls.push(u) },
      ),
    })
    expect(await already.ops.claimCredits!(ctx(CRED), account())).toMatchObject({ kind: 'already_claimed' })
    expect(claimCalls).toHaveLength(0)

    const claimable = createTraeProvider({
      fetcher: makeFetcher([
        { match: TRAE_CHECKIN_STATUS_PATH, json: { data: { enable: true, checked_in: false, credits: 100 } } },
        { match: TRAE_CHECKIN_CLAIM_PATH, json: { code: 0, data: {} } },
      ]),
    })
    expect(await claimable.ops.claimCredits!(ctx(CRED), account())).toMatchObject({ kind: 'success', credit: 100 })
  })

  it('reads quota with require_usage:true (mandatory)', async () => {
    let body: Record<string, unknown> | undefined
    const fetcher = makeFetcher([{ match: TRAE_ENT_USAGE_PATH, json: { data: { usage: { credits_amount: 1000, credits_used: 250 } } } }], (_u, init) => {
      if (init?.body) body = JSON.parse(String(init.body))
    })
    const p = createTraeProvider({ fetcher })
    const quota = await p.ops.getQuota!(ctx(CRED), account())
    expect(body).toEqual({ require_usage: true, req_source: 2 })
    expect(quota).toMatchObject({ known: true, remaining: 750, total: 1000 })
  })

  it('maps upstream auth failures', async () => {
    const fetcher = makeFetcher([{ match: TRAE_CHAT_PATH, status: 401 }])
    const p = createTraeProvider({ fetcher })
    await expect(
      p.chat.chat(ctx(CRED), { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }], stream: false }, account()),
    ).rejects.toMatchObject({ kind: 'AUTH_INVALID' })
  })

  it('lists fallback models when discovery is unavailable', async () => {
    const p = createTraeProvider({ fetcher: makeFetcher([]) })
    const models = await p.chat.listModels(ctx(CRED), account())
    expect(models.length).toBeGreaterThan(0)
    expect(models[0].provider).toBe('trae')
  })
})
