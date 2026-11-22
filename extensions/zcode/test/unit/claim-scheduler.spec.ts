/**
 * Auto-claim behaviour (ported from TriDefender/zcode-api, CC BY-NC-SA 4.0).
 *
 * The important properties are the backoff decisions, because a wrong one
 * either spams a first-come-first-served campaign (server biz 1005 caps daily
 * claims) or gives up on a plan that is still claimable.
 */
import { describe, expect, it } from 'vitest'
import { ClaimScheduler, type ClaimGateway } from '../../src/provider/zcode/claim/scheduler.js'
import { classifyClaimCode, CLAIM_FAILURE_LABELS } from '../../src/provider/zcode/claim/types.js'
import type { ClaimOutcome, ClaimablePlan } from '../../src/provider/zcode/claim/types.js'

const PLAN: ClaimablePlan = {
  planId: 'zcode-v3-start-plan-wk-1120',
  name: 'ZCODE WEEKEND BUILD',
  description: '',
  priority: 101,
  entitlements: [],
  startsAt: 1_800_000_000,
  endsAt: 1_900_000_000,
}

function gateway(overrides: Partial<ClaimGateway> = {}): ClaimGateway {
  return {
    async listPlans() { return [PLAN] },
    async claim(): Promise<ClaimOutcome> { return { ok: true, planId: PLAN.planId, endsAt: PLAN.endsAt } },
    ...overrides,
  }
}

function scheduler(overrides: {
  client?: ClaimGateway
  jwt?: string | undefined
  captcha?: { verifyParam: string; region?: string }
  captchaRequired?: boolean
  pollIntervalMs?: number
  cooldownMs?: number
  planId?: string
  logs?: string[]
} = {}): ClaimScheduler {
  const logs = overrides.logs ?? []
  return new ClaimScheduler({
    getJwt: async () => ('jwt' in overrides ? overrides.jwt : 'jwt-abc'),
    createClient: () => overrides.client ?? gateway(),
    getCaptcha: async () => overrides.captcha ?? { verifyParam: 'v'.repeat(280), region: 'sgp' },
    ...(overrides.captchaRequired === false ? { captchaRequired: () => false } : {}),
    config: {
      ...(overrides.planId ? { planId: overrides.planId } : {}),
      pollIntervalMs: overrides.pollIntervalMs ?? 300_000,
      cooldownMs: overrides.cooldownMs ?? 600_000,
    },
    log: (m) => logs.push(m),
  })
}

describe('claim failure classification', () => {
  it('maps the documented biz codes', () => {
    expect(classifyClaimCode(1001)).toBe('not_found')
    expect(classifyClaimCode(1002)).toBe('unavailable')
    expect(classifyClaimCode(1003)).toBe('already_claimed')
    expect(classifyClaimCode(1004)).toBe('ineligible')
    expect(classifyClaimCode(1005)).toBe('quota_exhausted')
    expect(classifyClaimCode(3001)).toBe('invalid_request')
    expect(classifyClaimCode(3007)).toBe('captcha')
    expect(classifyClaimCode(401)).toBe('login_required')
    expect(classifyClaimCode('1003')).toBe('already_claimed')
    expect(classifyClaimCode(9999)).toBe('unknown')
  })

  it('labels every kind for the operator', () => {
    for (const kind of Object.keys(CLAIM_FAILURE_LABELS)) {
      expect(CLAIM_FAILURE_LABELS[kind as keyof typeof CLAIM_FAILURE_LABELS]).toBeTruthy()
    }
  })
})

describe('claim scheduler', () => {
  it('claims the highest-priority plan and holds until its ends_at', async () => {
    const lower = { ...PLAN, planId: 'low', priority: 1 }
    const result = await scheduler({
      client: gateway({ async listPlans() { return [lower, PLAN] } }),
    }).tick()

    expect(result).toMatchObject({ action: 'claimed', planId: PLAN.planId })
  })

  it('claims a configured plan id only when the campaign offers it', async () => {
    const missing = await scheduler({ planId: 'not-in-campaign' }).tick()
    expect(missing).toEqual({ action: 'idle' })

    const hit = await scheduler({ planId: PLAN.planId }).tick()
    expect(hit).toMatchObject({ action: 'claimed', planId: PLAN.planId })
  })

  it('idles while no plan is available', async () => {
    const result = await scheduler({ client: gateway({ async listPlans() { return [] } }) }).tick()
    expect(result).toEqual({ action: 'idle' })
  })

  it('backs off instead of claiming when no JWT exists yet', async () => {
    const logs: string[] = []
    const result = await scheduler({ jwt: undefined, logs }).tick()
    expect(result).toMatchObject({ action: 'error', holdMs: 600_000 })
    expect(logs.join(' ')).toMatch(/no JWT available/)
  })

  it('passes the captcha pair to the claim call', async () => {
    let seen: { verifyParam: string; region?: string } | undefined
    await scheduler({
      client: gateway({
        async claim(_planId, captcha) {
          seen = captcha
          return { ok: true, planId: PLAN.planId }
        },
      }),
    }).tick()
    expect(seen).toEqual({ verifyParam: 'v'.repeat(280), region: 'sgp' })
  })

  it('omits the captcha when the gate says it is not required', async () => {
    let seen: unknown = 'unset'
    await scheduler({
      captchaRequired: false,
      client: gateway({
        async claim(_planId, captcha) {
          seen = captcha
          return { ok: true, planId: PLAN.planId }
        },
      }),
    }).tick()
    expect(seen).toBeUndefined()
  })

  it('stops permanently on login_required', async () => {
    const s = scheduler({
      client: gateway({
        async claim() {
          return { ok: false, planId: PLAN.planId, failureKind: 'login_required', code: 401, message: 'nope' }
        },
      }),
    })
    const result = await s.tick()
    expect(result).toMatchObject({ action: 'failed' })
    expect(s.isStopped()).toBe(true)
    expect(await s.tick()).toEqual({ action: 'stopped' })
  })

  it('holds until failureEndsAt for already_claimed / quota_exhausted', async () => {
    const now = 1_700_000_000_000
    const failureEndsAt = Math.floor(now / 1000) + 3600
    const outcome = {
      ok: false as const, planId: PLAN.planId, failureKind: 'already_claimed' as const,
      code: 1003, message: 'already claimed', failureEndsAt,
    }
    const s = new ClaimScheduler({
      getJwt: async () => 'jwt',
      createClient: () => gateway({ async claim() { return outcome } }),
      getCaptcha: async () => ({ verifyParam: 'v'.repeat(280) }),
      config: { pollIntervalMs: 1000, cooldownMs: 10 },
      now: () => now,
    })
    const result = await s.tick()
    expect(result).toMatchObject({ action: 'failed', holdMs: 3_600_000 })
    // The next tick inside the hold window must not call upstream again.
    expect(await s.tick()).toEqual({ action: 'skipped_hold' })
  })

  it('uses the cooldown for transient failures', async () => {
    const result = await scheduler({
      client: gateway({
        async claim() {
          return { ok: false, planId: PLAN.planId, failureKind: 'captcha', code: 3007, message: 'captcha failed' }
        },
      }),
    }).tick()
    expect(result).toMatchObject({ action: 'failed', holdMs: 600_000 })
  })

  it('backs off when the captcha token cannot be produced (never claims bare)', async () => {
    const s = new ClaimScheduler({
      getJwt: async () => 'jwt',
      createClient: () => gateway(),
      getCaptcha: async () => { throw new Error('solver unavailable') },
      config: { pollIntervalMs: 300_000, cooldownMs: 600_000 },
    })
    const result = await s.tick()
    expect(result).toMatchObject({ action: 'error' })
    expect((result as { message: string }).message).toMatch(/captcha token failed/)
  })

  it('treats a preview failure as a retryable error', async () => {
    const result = await scheduler({
      client: gateway({ async listPlans() { throw new Error('network down') } }),
    }).tick()
    expect(result).toMatchObject({ action: 'error' })
  })
})
