/**
 * POST /v1/accounts/:id/claim — daily check-in credit claim.
 *
 * All branches run against the fake upstream; no real Tencent call. The
 * outcome contract mirrors Core's ClaimOutcome: `unsupported` never appears
 * here (the extension implements the operation), and no branch reports
 * success without an affirmative upstream `code: 0`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, type HarnessResult } from './helpers.js'

describe('claim endpoint (POST /v1/accounts/:id/claim)', () => {
  let h: HarnessResult
  let accountId: string

  beforeEach(async () => {
    h = await startHarness()
    accountId = await login(h)
  })

  afterEach(async () => {
    await h.close()
  })

  it('registers the route: unknown account → 404 TERMINAL body', async () => {
    const res = await h.request('POST', '/v1/accounts/does-not-exist/claim')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect((body.error as Record<string, unknown>).kind).toBe('TERMINAL')
  })

  it('activity inactive → not_available, claim endpoint never called', async () => {
    h.fake.behaviour.checkinStatus = { active: false, today_checked_in: false }
    const res = await h.request('POST', `/v1/accounts/${accountId}/claim`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outcome).toEqual({ kind: 'not_available', message: 'check-in activity is not active' })
    expect(h.fake.checkinClaimCalls).toBe(0)
  })

  it('already checked in → already_claimed, claim endpoint never called', async () => {
    h.fake.behaviour.checkinStatus = { active: true, today_checked_in: true, streak_days: 3, daily_credit: 5 }
    const res = await h.request('POST', `/v1/accounts/${accountId}/claim`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outcome).toEqual({ kind: 'already_claimed', message: 'already checked in today' })
    expect(h.fake.checkinClaimCalls).toBe(0)
  })

  it('activity active and unclaimed → real claim, success carries the credit', async () => {
    h.fake.behaviour.checkinStatus = { active: true, today_checked_in: false }
    h.fake.behaviour.checkinClaimResponse = {
      status: 200,
      body: { code: 0, data: { credit: 5, streak_days: 4 } },
    }
    const res = await h.request('POST', `/v1/accounts/${accountId}/claim`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outcome.kind).toBe('success')
    expect((body.outcome as Record<string, unknown>).credit).toBe(5)
    expect(String((body.outcome as Record<string, unknown>).message)).toContain('+5 credit')
    expect(h.fake.checkinClaimCalls).toBe(1)
  })

  it('upstream business codes map per the contract', async () => {
    const cases: Array<{ code: number; kind: string }> = [
      { code: 10001, kind: 'already_claimed' },
      { code: 1001, kind: 'already_claimed' },
      { code: 1002, kind: 'not_available' },
      { code: 1003, kind: 'not_available' },
      { code: -1, kind: 'failed' },
      { code: 9999, kind: 'failed' },
    ]
    for (const c of cases) {
      h.fake.behaviour.checkinStatus = { active: true, today_checked_in: false }
      h.fake.behaviour.checkinClaimResponse = { status: 200, body: { code: c.code, message: `code ${c.code}` } }
      const res = await h.request('POST', `/v1/accounts/${accountId}/claim`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect((body.outcome as Record<string, unknown>).kind).toBe(c.kind)
    }
  })

  it('upstream HTTP 401/403 map to needs_auth / needs_manual_action', async () => {
    h.fake.behaviour.checkinStatus = { active: true, today_checked_in: false }
    h.fake.behaviour.checkinClaimResponse = { status: 401, body: { code: 401 } }
    let res = await h.request('POST', `/v1/accounts/${accountId}/claim`)
    expect(await res.json()).toMatchObject({ outcome: { kind: 'needs_auth' } })

    h.fake.behaviour.checkinClaimResponse = { status: 403, body: { code: 403 } }
    res = await h.request('POST', `/v1/accounts/${accountId}/claim`)
    expect(await res.json()).toMatchObject({ outcome: { kind: 'needs_manual_action' } })
  })

  it('claim response missing data is failed, never success', async () => {
    h.fake.behaviour.checkinStatus = { active: true, today_checked_in: false }
    h.fake.behaviour.checkinClaimResponse = { status: 200, body: { code: 0 } }
    const res = await h.request('POST', `/v1/accounts/${accountId}/claim`)
    const body = await res.json()
    expect((body.outcome as Record<string, unknown>).kind).toBe('failed')
    expect((body.outcome as Record<string, unknown>).message).toContain('missing data')
  })

  it('non-JSON / unrecognized claim payloads are failed, never success', async () => {
    h.fake.behaviour.checkinStatus = { active: true, today_checked_in: false }
    h.fake.behaviour.checkinClaimResponse = { status: 200, body: { unexpected: 'shape' } }
    const res = await h.request('POST', `/v1/accounts/${accountId}/claim`)
    const body = await res.json()
    expect((body.outcome as Record<string, unknown>).kind).toBe('failed')
  })

  it('status endpoint failure → failed (no claim attempt, no fake success)', async () => {
    h.fake.behaviour.checkinStatusStatus = 503
    const res = await h.request('POST', `/v1/accounts/${accountId}/claim`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect((body.outcome as Record<string, unknown>).kind).toBe('failed')
    expect(h.fake.checkinClaimCalls).toBe(0)
  })

  it('wrong method on the claim path is not routed (GET → 404)', async () => {
    const res = await h.request('GET', `/v1/accounts/${accountId}/claim`)
    expect(res.status).toBe(404)
  })

  it('other account routes still work after the claim route was added', async () => {
    const detail = await h.request('GET', `/v1/accounts/${accountId}`)
    expect(detail.status).toBe(200)
    const quota = await h.request('GET', `/v1/accounts/${accountId}/quota`)
    expect(quota.status).toBe(200)
  })
})

/** Drive the external-link login to an active account (same pattern as provider.spec). */
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
