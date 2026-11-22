/**
 * Claim client: the two enumeration faces (billing preview + marketing banner)
 * and the claim call's header discipline.
 */
import { describe, expect, it } from 'vitest'
import { createClaimClient } from '../../src/provider/zcode/claim/client.js'
import { ClaimPreviewError } from '../../src/provider/zcode/claim/types.js'

interface Call {
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}

function stub(routes: Record<string, { status: number; json: unknown }>, calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({
      method,
      path: url.pathname + url.search,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    })
    const route = routes[`${method} ${url.pathname}`]
    if (!route) {
      return new Response(JSON.stringify({ code: 1001, msg: 'not found' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(route.json), {
      status: route.status, headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const PREVIEW = {
  code: 0,
  data: {
    plans: [{
      plan_id: 'zcode-v3-start-plan-wk-1120',
      name: 'ZCODE WEEKEND BUILD',
      priority: 101,
      starts_at: 1_800_000_000,
      ends_at: 1_900_000_000,
      entitlements: [{
        entitlement_id: 'ent-1', show_name: 'GLM-5.3-Flash', meter: 'model_usage',
        unit_type: 'token', capabilities: ['model:glm-5.3-flash'], grant_units: 500_000_000,
        period: 'one_time', priority: 101, effective_at: 1_800_000_100,
      }],
    }],
  },
}

describe('claim client', () => {
  it('parses the billing preview shape', async () => {
    const calls: Call[] = []
    const client = createClaimClient({
      origin: 'https://zcode.z.ai', jwt: 'jwt', appVersion: '3.19.1', platform: 'linux-x64',
      fetchImpl: stub({ 'GET /api/v1/zcode-plan/billing/preview': { status: 200, json: PREVIEW } }, calls),
    })
    const plans = await client.getPreviews()
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      planId: 'zcode-v3-start-plan-wk-1120',
      priority: 101,
      startsAt: 1_800_000_000,
      endsAt: 1_900_000_000,
    })
    expect(plans[0]!.entitlements[0]).toMatchObject({
      showName: 'GLM-5.3-Flash', grantUnits: 500_000_000, effectiveAt: 1_800_000_100,
    })
    // Preview sends Authorization only (no Content-Type, no identity bundle).
    expect(calls[0]!.headers.Authorization).toBe('Bearer jwt')
    expect(calls[0]!.headers['Content-Type']).toBeUndefined()
    expect(calls[0]!.path).toContain('app_version=3.19.1')
  })

  it('treats code 0 without data as "no campaign" (empty list)', async () => {
    const client = createClaimClient({
      origin: 'https://zcode.z.ai', jwt: 'jwt', appVersion: '3.19.1', platform: 'linux-x64',
      fetchImpl: stub({ 'GET /api/v1/zcode-plan/billing/preview': { status: 200, json: { code: 0, msg: '' } } }, []),
    })
    expect(await client.getPreviews()).toEqual([])
  })

  it('surfaces a preview failure with its status', async () => {
    const client = createClaimClient({
      origin: 'https://zcode.z.ai', jwt: 'jwt', appVersion: '3.19.1', platform: 'linux-x64',
      fetchImpl: stub({ 'GET /api/v1/zcode-plan/billing/preview': { status: 400, json: { code: 3001, msg: 'parameter error' } } }, []),
    })
    await expect(client.getPreviews()).rejects.toBeInstanceOf(ClaimPreviewError)
  })

  it('reads banner plans from the marketing face', async () => {
    const marketing = {
      code: 0,
      data: {
        deliveries: [{
          campaign_id: 'wk-1030',
          banner: {
            background: { args: { zcode_plan: { plan_id: 'plan-from-banner', name: 'Weekend', priority: 5, ends_at: 1_900_000_000 } } },
            buttons: [{ action: { type: 'claim_zcode_plan', args: { plan_id: 'plan-from-banner' } } }],
          },
        }],
      },
    }
    const calls: Call[] = []
    const client = createClaimClient({
      origin: 'https://zcode.z.ai', jwt: 'jwt', appVersion: '3.19.1', platform: 'linux-x64',
      deviceMid: '7f1c7f3e-0000-4000-8000-000000000000',
      fetchImpl: stub({ 'GET /api/v1/marketing/touch': { status: 200, json: marketing } }, calls),
    })
    const plans = await client.getMarketingPlans()
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ planId: 'plan-from-banner', source: 'banner', campaignId: 'wk-1030' })
    // The marketing face needs the device id and the app version.
    expect(calls[0]!.headers['X-Device-Mid']).toBeDefined()
    expect(calls[0]!.headers['X-ZCode-App-Version']).toBe('3.19.1')
  })

  it('merges both faces, preferring the billing preview', async () => {
    const marketing = {
      code: 0,
      data: {
        deliveries: [{
          banner: {
            background: { args: { zcode_plan: { plan_id: 'dup', name: 'Dup', priority: 9 } } },
            buttons: [{ action: { type: 'claim_zcode_plan', args: { plan_id: 'dup' } } }],
          },
        }],
      },
    }
    const client = createClaimClient({
      origin: 'https://zcode.z.ai', jwt: 'jwt', appVersion: '3.19.1', platform: 'linux-x64',
      deviceMid: 'dev-mid',
      fetchImpl: stub({
        'GET /api/v1/zcode-plan/billing/preview': { status: 200, json: { code: 0, data: { plans: [{ plan_id: 'dup', name: 'FromPreview', priority: 9 }] } } },
        'GET /api/v1/marketing/touch': { status: 200, json: marketing },
      }, []),
    })
    const plans = await client.listPlans()
    expect(plans).toHaveLength(1)
    expect(plans[0]!.name).toBe('FromPreview')
    expect(plans[0]!.source).toBeUndefined()
  })

  it('claims with the captcha pair and the version headers', async () => {
    const calls: Call[] = []
    const client = createClaimClient({
      origin: 'https://zcode.z.ai', jwt: 'jwt', appVersion: '3.19.1', platform: 'linux-x64',
      deviceMid: 'dev-mid',
      fetchImpl: stub({
        'POST /api/v1/zcode-plan/billing/claim': {
          status: 200, json: { code: 0, data: { plan: { plan_id: 'p1', starts_at: 1_800_000_000, ends_at: 1_900_000_000 } } },
        },
      }, calls),
    })
    const outcome = await client.claim('p1', { verifyParam: 'vp', region: 'sgp' })
    expect(outcome).toEqual({ ok: true, planId: 'p1', startsAt: 1_800_000_000, endsAt: 1_900_000_000 })
    const call = calls[0]!
    expect(JSON.parse(call.body!)).toEqual({ plan_id: 'p1' })
    expect(call.headers['X-Aliyun-Captcha-Verify-Param']).toBe('vp')
    expect(call.headers['X-Aliyun-Captcha-Verify-Region']).toBe('sgp')
    expect(call.headers['X-ZCode-App-Version']).toBe('3.19.1')
    expect(call.headers['X-Platform']).toBe('linux-x64')
    expect(call.headers['X-Device-Mid']).toBe('dev-mid')
  })

  it('maps a biz failure code to its kind', async () => {
    const client = createClaimClient({
      origin: 'https://zcode.z.ai', jwt: 'jwt', appVersion: '3.19.1', platform: 'linux-x64',
      fetchImpl: stub({
        'POST /api/v1/zcode-plan/billing/claim': { status: 200, json: { code: 1003, msg: 'already claimed' } },
      }, []),
    })
    const outcome = await client.claim('p1')
    expect(outcome).toMatchObject({ ok: false, failureKind: 'already_claimed', code: 1003 })
  })

  it('refuses to claim without a JWT', async () => {
    const client = createClaimClient({
      origin: 'https://zcode.z.ai', appVersion: '3.19.1', platform: 'linux-x64',
      fetchImpl: stub({}, []),
    })
    expect(await client.claim('p1')).toMatchObject({ ok: false, failureKind: 'login_required' })
  })
})
