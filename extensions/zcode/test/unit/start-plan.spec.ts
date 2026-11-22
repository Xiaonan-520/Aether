/**
 * start-plan support (ported from TriDefender/zcode-api, CC BY-NC-SA 4.0).
 *
 * Trial/"weekend" accounts are only entitled to glm-5.3-flash, and their edge
 * rejects a bare Anthropic request with `3012 "This client is not supported"`.
 * Two things make such a request acceptable: the ZCode identity blocks in
 * `system` (+ the date attachment and metadata blob) and a captcha token on
 * every request. coding-plan accounts carry neither, so both behaviours are
 * gated on the detected plan.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, type HarnessResult } from './helpers.js'
import { detectPlanFromBilling } from '../../src/provider/zcode/plan.js'
import { toAnthropicBody } from '../../src/provider/zcode/anthropic.js'
import { buildCurrentDateMessage, buildStartPlanSystem } from '../../src/provider/zcode/system-prompt.js'
import type { ExtensionChatRequest } from '../../src/protocol/types.js'

let h: HarnessResult

beforeEach(async () => {
  h = await startHarness()
})

afterEach(async () => {
  if (h) await h.close()
})

async function login(harness: HarnessResult, prefix = 'zc'): Promise<string> {
  const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`
  await harness.request('POST', '/v1/accounts', { accountId: id, loginMode: 'oauth' })
  await harness.request('POST', `/v1/accounts/${id}/login`, {})
  harness.fake.behaviour.tokenReadyAfterPolls = 1
  for (let i = 0; i < 30; i++) {
    const detail = await harness.request('GET', `/v1/accounts/${id}`)
    const account = ((await detail.json()) as { account: { status: string } }).account
    if (account.status === 'active') return id
  }
  throw new Error('login did not complete')
}

const START_PLAN_BILLING = {
  code: 0,
  data: {
    plans: [{
      plan_id: 'zcode-v3-start-plan-wk-1120',
      name: 'ZCODE WEEKEND BUILD',
      status: 'active',
      ends_at: 1_900_000_000,
      entitlements: [{ show_name: 'GLM-5.3-Flash', grant_units: 500_000_000 }],
    }],
  },
}

const CODING_PLAN_BILLING = {
  code: 0,
  data: {
    plans: [{
      plan_id: 'zcode-v3-coding-plan-pro',
      name: 'ZCODE PRO',
      status: 'active',
      ends_at: 1_900_000_000,
      entitlements: [{ grant_units: 1000 }],
    }],
  },
}

describe('plan detection', () => {
  it('classifies a start-plan billing payload', () => {
    expect(detectPlanFromBilling(START_PLAN_BILLING)).toBe('start-plan')
  })

  it('classifies a coding-plan billing payload', () => {
    expect(detectPlanFromBilling(CODING_PLAN_BILLING)).toBe('coding-plan')
  })

  it('returns undefined when the payload carries no usable plan list', () => {
    expect(detectPlanFromBilling(undefined)).toBeUndefined()
    expect(detectPlanFromBilling({ data: {} })).toBeUndefined()
    expect(detectPlanFromBilling({ data: { plans: [] } })).toBeUndefined()
    // only expired plans → no opinion, keep whatever we had
    expect(detectPlanFromBilling({
      data: { plans: [{ plan_id: 'zcode-v3-start-plan-wk-1', status: 'expired' }] },
    })).toBeUndefined()
  })
})

describe('start-plan body shape', () => {
  const REQ = {
    accountId: 'a',
    model: 'glm-5.3-flash',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  } as unknown as ExtensionChatRequest

  it('injects the three identity blocks, date attachment and metadata for start-plan', () => {
    const body = toAnthropicBody(REQ, 'GLM-5.3-Flash', 'start-plan')
    const system = body.system as Array<{ type: string; text: string; cache_control?: unknown }>
    expect(system).toHaveLength(3)
    expect(system[0]!.text).toBe('You are ZCode, an interactive agent')
    expect(system[0]!.cache_control).toBeUndefined()
    expect(system[1]!.text.length).toBeGreaterThan(500)
    expect(system[1]!.cache_control).toEqual({ type: 'ephemeral' })

    const messages = body.messages as Array<{ role: string; content: Array<{ text: string }> }>
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content[0]!.text).toMatch(/^<system-reminder>Today's date is \d{4}-\d{2}-\d{2}\.<\/system-reminder>$/)
    expect(messages[1]!.role).toBe('user')

    const metadata = body.metadata as { user_id: string }
    const parsed = JSON.parse(metadata.user_id) as { account_uuid: string; session_id: string }
    expect(parsed.account_uuid).toBe('')
  })

  it('leaves coding-plan bodies untouched', () => {
    const body = toAnthropicBody(REQ, 'GLM-5.3-Flash', 'coding-plan')
    expect(body.system).toBeUndefined()
    expect(body.metadata).toBeUndefined()
    const messages = body.messages as Array<{ role: string }>
    expect(messages).toHaveLength(1)
  })

  it('puts a caller system prompt in the third block', () => {
    const withSystem = {
      ...REQ,
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }],
    } as unknown as ExtensionChatRequest
    const body = toAnthropicBody(withSystem, 'GLM-5.3-Flash', 'start-plan')
    const system = body.system as Array<{ text: string }>
    expect(system[2]!.text).toBe('\n\nbe brief')
  })

  it('builds the date attachment in the client wire shape', () => {
    const msg = buildCurrentDateMessage(new Date(2026, 10, 22))
    expect(msg.role).toBe('user')
    expect(msg.content[0]!.text).toBe("<system-reminder>Today's date is 2026-11-22.</system-reminder>")
  })

  it('omits the third block text when there is no client system prompt', () => {
    const blocks = buildStartPlanSystem(undefined)
    expect(blocks[2]!.text).toBe('')
  })
})

describe('start-plan chat behaviour', () => {
  // start-plan refuses to send without a token, and the harness must not reach
  // the real solver — so run in manual mode and pre-submit a token, which is
  // the same cache the human handoff page fills.
  beforeEach(async () => {
    if (h) await h.close()
    h = await startHarness({ config: { captchaMode: 'manual' } })
  })

  async function submitToken(harness: HarnessResult): Promise<void> {
    const res = await harness.request('POST', '/v1/captcha', { verify_param: 'v'.repeat(300) })
    expect(res.status).toBe(200)
  }

  it('learns the plan from billing and sends the captcha region header', async () => {
    const id = await login(h, 'zc-start')
    h.fake.behaviour.quotaPayload = START_PLAN_BILLING.data
    // a quota refresh is what classifies the plan
    await h.request('GET', `/v1/accounts/${id}/quota`)
    await submitToken(h)

    const res = await h.request('POST', '/v1/chat', {
      accountId: id,
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(res.status).toBe(200)

    const body = h.fake.lastChatBody as Record<string, unknown>
    expect(body.model).toBe('GLM-5.3-Flash')
    // The start-plan shape: identity blocks replace the (absent) system field.
    expect(Array.isArray(body.system)).toBe(true)
    expect((body.system as unknown[]).length).toBe(3)
    expect(h.fake.lastChatHeaders?.['x-aliyun-captcha-verify-region']).toBeDefined()
  })

  it('refuses to send a start-plan request without any token', async () => {
    const id = await login(h, 'zc-start2')
    h.fake.behaviour.quotaPayload = START_PLAN_BILLING.data
    await h.request('GET', `/v1/accounts/${id}/quota`)

    // No pre-submitted token and a 1s wait budget → honest NEEDS_CAPTCHA,
    // never a bare request.
    const res = await h.request('POST', '/v1/chat', {
      accountId: id,
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(res.status).toBe(409)
    expect(h.fake.lastChatHeaders).toBeUndefined()
  })

  it('keeps coding-plan requests bare of identity blocks', async () => {
    const id = await login(h, 'zc-code')
    h.fake.behaviour.quotaPayload = CODING_PLAN_BILLING.data
    await h.request('GET', `/v1/accounts/${id}/quota`)

    const res = await h.request('POST', '/v1/chat', {
      accountId: id,
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(res.status).toBe(200)
    const body = h.fake.lastChatBody as Record<string, unknown>
    expect(body.system).toBeUndefined()
    expect(body.metadata).toBeUndefined()
  })
})
