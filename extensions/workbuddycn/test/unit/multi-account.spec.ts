/**
 * Multi-account behaviour for the WorkBuddyCN extension (simulated credentials).
 *
 * These tests never contact a real upstream. They pin:
 *  - two accounts have distinct extension-side credentials and chats use the
 *    account Core asked for (no cross-talk);
 *  - disabling/invalidating one account does not affect the other;
 *  - quota caches are per account;
 *  - concurrent refreshes for one account are single-flight (no refresh-token
 *    rotation race);
 *  - quota refresh works when the access token has expired.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, type HarnessResult } from './helpers.js'

let h: HarnessResult

beforeEach(async () => {
  h = await startHarness()
})

afterEach(async () => {
  if (h) await h.close()
})

async function login(h: HarnessResult, prefix = 'wbcn'): Promise<string> {
  const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`
  await h.request('POST', '/v1/accounts', { accountId: id, loginMode: 'external-link' })
  h.fake.behaviour.tokenReadyAfterPolls = 1
  for (let i = 0; i < 30; i++) {
    const detail = await h.request('GET', `/v1/accounts/${id}`)
    const status = ((await detail.json()).account as Record<string, unknown>).status
    if (status === 'active') return id
  }
  throw new Error('login did not complete')
}

function expireCredential(h: HarnessResult, accountId: string): void {
  const credential = h.app.store.getCredential(accountId)
  if (!credential) throw new Error(`no credential for ${accountId}`)
  h.app.store.saveCredential(accountId, {
    ...credential,
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  })
}

async function chat(h: HarnessResult, accountId: string): Promise<Response> {
  return fetch(`${h.base}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId,
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }),
  })
}

describe('WorkBuddyCN multi-account isolation', () => {
  it('keeps two accounts on separate credentials and uses the requested account', async () => {
    const a = await login(h, 'wbcn-a')
    const b = await login(h, 'wbcn-b')

    const ca = h.app.store.getCredential(a)!
    const cb = h.app.store.getCredential(b)!
    expect(ca.access_token).not.toBe(cb.access_token)

    h.fake.chatAuthorizations = []
    const ra = await chat(h, a)
    const rb = await chat(h, b)
    expect(ra.status).toBe(200)
    expect(rb.status).toBe(200)

    expect(h.fake.chatAuthorizations).toHaveLength(2)
    expect(h.fake.chatAuthorizations[0]).toContain(ca.access_token)
    expect(h.fake.chatAuthorizations[1]).toContain(cb.access_token)
    expect(h.fake.chatAuthorizations[0]).not.toContain(cb.access_token)
    expect(h.fake.chatAuthorizations[1]).not.toContain(ca.access_token)
  })

  it('disabling one account does not affect the other', async () => {
    const a = await login(h, 'wbcn-a')
    const b = await login(h, 'wbcn-b')

    await h.app.provider.setEnabled(a, false)
    const ra = await chat(h, a)
    expect(ra.status).toBe(502)
    expect(((await ra.json()) as { error: { kind: string } }).error.kind).toBe('AUTH_INVALID')

    const rb = await chat(h, b)
    expect(rb.status).toBe(200)
  })

  it('keeps quota caches separate per account', async () => {
    const a = await login(h, 'wbcn-a')
    const b = await login(h, 'wbcn-b')

    const qa = await h.request('GET', `/v1/accounts/${a}/quota`)
    const qb = await h.request('GET', `/v1/accounts/${b}/quota`)
    expect(qa.status).toBe(200)
    expect(qb.status).toBe(200)
    expect((await qa.json()).accountId).toBe(a)
    expect((await qb.json()).accountId).toBe(b)

    expect(h.app.store.getQuotaCache(a)).toBeDefined()
    expect(h.app.store.getQuotaCache(b)).toBeDefined()
  })
})

describe('WorkBuddyCN credential refresh', () => {
  it('single-flights concurrent refreshes for the same account', async () => {
    const a = await login(h, 'wbcn-a')
    expireCredential(h, a)
    h.fake.behaviour.refreshDelayMs = 250
    h.fake.refreshCalls = 0

    const [r1, r2] = await Promise.all([chat(h, a), chat(h, a)])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(h.fake.refreshCalls).toBe(1)
  })

  it('refreshes an expired credential before fetching quota', async () => {
    const a = await login(h, 'wbcn-a')
    expireCredential(h, a)
    h.fake.refreshCalls = 0

    const res = await h.request('GET', `/v1/accounts/${a}/quota`)
    expect(res.status).toBe(200)
    expect(h.fake.refreshCalls).toBe(1)
    expect((await res.json()).accountId).toBe(a)
  })
})
