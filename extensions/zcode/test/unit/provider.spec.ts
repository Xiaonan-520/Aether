/**
 * 多账号行为 + 协议语义（fake 上游，无真实网络）。
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

/** 走完整登录流（init → 轮询 GET 推进 → active） */
async function login(h: HarnessResult, prefix = 'zc'): Promise<string> {
  const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`
  await h.request('POST', '/v1/accounts', { accountId: id, loginMode: 'oauth' })
  const begin = await h.request('POST', `/v1/accounts/${id}/login`, {})
  expect(begin.status).toBe(200)
  const beginBody = (await begin.json()) as { authorizationUrl: string }
  expect(beginBody.authorizationUrl).toContain('oauth/login')
  h.fake.behaviour.tokenReadyAfterPolls = 1
  for (let i = 0; i < 30; i++) {
    const detail = await h.request('GET', `/v1/accounts/${id}`)
    const account = ((await detail.json()) as { account: { status: string } }).account
    if (account.status === 'active') return id
  }
  throw new Error('login did not complete')
}

async function chat(h: HarnessResult, accountId: string): Promise<Response> {
  return fetch(`${h.base}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.config.authToken}` },
    body: JSON.stringify({
      accountId,
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }),
  })
}

describe('ZCode multi-account', () => {
  it('keeps two accounts on separate credentials and uses the requested account', async () => {
    const a = await login(h, 'zc-a')
    const b = await login(h, 'zc-b')

    const ca = h.app.store.getCredential(a)!
    const cb = h.app.store.getCredential(b)!
    expect(ca.jwt_token).not.toBe(cb.jwt_token)

    h.fake.chatAuthorizations = []
    const ra = await chat(h, a)
    const rb = await chat(h, b)
    expect(ra.status).toBe(200)
    expect(rb.status).toBe(200)

    expect(h.fake.chatAuthorizations).toHaveLength(2)
    expect(h.fake.chatAuthorizations[0]).toContain(ca.jwt_token!)
    expect(h.fake.chatAuthorizations[1]).toContain(cb.jwt_token!)
    expect(h.fake.chatAuthorizations[0]).not.toContain(cb.jwt_token!)
  })

  it('disabling one account does not affect the other', async () => {
    const a = await login(h, 'zc-a')
    const b = await login(h, 'zc-b')

    await h.app.provider.setEnabled(a, false)
    const ra = await chat(h, a)
    expect(ra.status).toBe(502)
    expect(((await ra.json()) as { error: { kind: string } }).error.kind).toBe('AUTH_INVALID')

    const rb = await chat(h, b)
    expect(rb.status).toBe(200)
  })

  it('re-enabling an account with a credential restores active (not pending)', async () => {
    const a = await login(h, 'zc-a')
    await h.app.provider.setEnabled(a, false)
    const off = await h.app.provider.setEnabled(a, true)
    expect(off.status).toBe('active')
    const detail = await h.request('GET', `/v1/accounts/${a}`)
    expect(((await detail.json()) as { account: { status: string } }).account.status).toBe('active')
  })

  it('deletes an account and its credential', async () => {
    const a = await login(h, 'zc-a')
    const del = await h.request('DELETE', `/v1/accounts/${a}`)
    expect(del.status).toBe(200)
    expect(h.app.store.getAccount(a)).toBeUndefined()
    expect(h.app.store.getCredential(a)).toBeUndefined()
    const after = await h.request('GET', `/v1/accounts/${a}`)
    expect(after.status).toBe(404)
  })
})

describe('ZCode login flow', () => {
  it('login polls are single-flighted under concurrent GETs', async () => {
    const id = `zc-lf-${Math.random().toString(36).slice(2, 8)}`
    await h.request('POST', '/v1/accounts', { accountId: id, loginMode: 'oauth' })
    await h.request('POST', `/v1/accounts/${id}/login`, {})
    h.fake.behaviour.tokenReadyAfterPolls = 3
    // 并发 5 个 GET —— poll 次数应远小于 5 轮独立轮询的总和
    await Promise.all([
      h.request('GET', `/v1/accounts/${id}`),
      h.request('GET', `/v1/accounts/${id}`),
      h.request('GET', `/v1/accounts/${id}`),
      h.request('GET', `/v1/accounts/${id}`),
      h.request('GET', `/v1/accounts/${id}`),
    ])
    expect(h.fake.pollCalls).toBeLessThan(5)
  })

  it('rejects credential fields on account creation (protocol boundary)', async () => {
    const res = await h.request('POST', '/v1/accounts', {
      accountId: 'zc-cred',
      loginMode: 'oauth',
      jwt_token: 'smuggled',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { kind: string } }).error.kind).toBe('PROTOCOL_VIOLATION')
  })

  it('imports a credential directly (paste flow)', async () => {
    const id = `zc-imp-${Math.random().toString(36).slice(2, 8)}`
    await h.request('POST', '/v1/accounts', { accountId: id, loginMode: 'oauth' })
    const res = await h.request('POST', `/v1/accounts/${id}/import-credential`, { jwt_token: 'pasted-jwt-xyz' })
    expect(res.status).toBe(200)
    const detail = await h.request('GET', `/v1/accounts/${id}`)
    expect(((await detail.json()) as { account: { status: string } }).account.status).toBe('active')
  })
})

describe('ZCode chat semantics', () => {
  it('maps upstream 401 to AUTH_INVALID', async () => {
    const a = await login(h, 'zc-a')
    h.fake.behaviour.chatStatus = 401
    const res = await chat(h, a)
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { kind: string } }).error.kind).toBe('AUTH_INVALID')
  })

  it('maps upstream 429 to RATE_LIMIT (retryable)', async () => {
    const a = await login(h, 'zc-a')
    h.fake.behaviour.chatStatus = 429
    const res = await chat(h, a)
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { kind: string; retryable?: boolean } }
    expect(body.error.kind).toBe('RATE_LIMIT')
    expect(body.error.retryable).toBe(true)
  })

  it('maps upstream 400 {"code":3007} to NEEDS_CAPTCHA when no human token arrives', async () => {
    const a = await login(h, 'zc-a')
    h.fake.behaviour.chatChallengeBody = true
    const res = await chat(h, a)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { kind: string } }).error.kind).toBe('NEEDS_CAPTCHA')
  })

  it('maps upstream 403 + captcha header to NEEDS_CAPTCHA when no human token arrives', async () => {
    const a = await login(h, 'zc-a')
    h.fake.behaviour.chatChallengeHeader = true
    const res = await chat(h, a)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { kind: string } }).error.kind).toBe('NEEDS_CAPTCHA')
  })

  it('resolves a challenge after a human submits a token (retry succeeds)', async () => {
    const a = await login(h, 'zc-a')
    // 第一次请求被挑战；在等待窗口内提交人工令牌 → 重试成功
    h.fake.behaviour.chatChallengeBody = true
    const pending = chat(h, a)
    await new Promise((r) => setTimeout(r, 100))
    const submit = await h.request('POST', '/v1/captcha', { verify_param: 'human-token-abc' })
    expect(submit.status).toBe(200)
    const res = await pending
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: string }
    expect(body.content).toBe('Hello world')
    // 令牌已被缓存消费，后续请求直接带上
    expect(h.fake.chatAuthorizations.at(-1)).not.toBeUndefined()
  })

  it('non-streaming chat aggregates anthropic SSE into a ChatResult', async () => {
    const a = await login(h, 'zc-a')
    const res = await chat(h, a)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: string; finishReason: string }
    expect(body.content).toBe('Hello world')
    expect(body.finishReason).toBe('stop')
  })

  it('streams chunk frames then exactly one done frame', async () => {
    const a = await login(h, 'zc-a')
    const res = await h.chatStream({ accountId: a, model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    const text = await res.text()
    const events = text.split('\n').filter((l) => l.startsWith('event:')).map((l) => l.slice(6).trim())
    expect(events.filter((e) => e === 'chunk').length).toBe(2)
    expect(events.filter((e) => e === 'done').length).toBe(1)
  })

  it('rejects a provider-prefixed model id', async () => {
    const res = await h.request('POST', '/v1/chat', {
      accountId: 'whatever',
      model: 'zcode::glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { kind: string } }).error.kind).toBe('PROTOCOL_VIOLATION')
  })
})

describe('ZCode quota', () => {
  it('returns a QuotaSnapshot with the declared tokens resource', async () => {
    const a = await login(h, 'zc-a')
    const res = await h.request('GET', `/v1/accounts/${a}/quota`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { accountId: string; resources: Array<{ id: string; kind: string; remaining: number | null; total: number | null; status: string }> }
    expect(body.accountId).toBe(a)
    expect(body.resources[0]!.kind).toBe('tokens')
    expect(body.resources[0]!.remaining).toBe(42)
    expect(body.resources[0]!.status).toBe('ok')
  })

  it('quota caches are separate per account', async () => {
    const a = await login(h, 'zc-a')
    const b = await login(h, 'zc-b')
    await h.request('GET', `/v1/accounts/${a}/quota`)
    await h.request('GET', `/v1/accounts/${b}/quota`)
    expect(h.app.store.getQuotaCache(a)).toBeDefined()
    expect(h.app.store.getQuotaCache(b)).toBeDefined()
  })
})

describe('ZCode captcha handoff', () => {
  it('serves the captcha page without auth and accepts a submitted token', async () => {
    const page = await fetch(`${h.base}/v1/captcha`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('AliyunCaptchaConfig')
    expect(html).toContain('initAliyunCaptcha')

    const submit = await h.request('POST', '/v1/captcha', { verify_param: 'human-token-123' })
    expect(submit.status).toBe(200)
    expect(((await submit.json()) as { ok: boolean }).ok).toBe(true)
    expect(h.app.provider.getCaptcha().peek()).toBe('human-token-123')
  })

  it('requires the extension bearer for token submission', async () => {
    const res = await fetch(`${h.base}/v1/captcha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verify_param: 'x' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('ZCode captcha action channel', () => {
  it('accepts a captcha token via the declared submit-captcha action', async () => {
    const res = await h.request('POST', '/v1/actions/submit-captcha', { verify_param: 'via-action-1' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { result: { ok: boolean } }).result.ok).toBe(true)
    expect(h.app.provider.getCaptcha().peek()).toBe('via-action-1')
  })

  it('rejects undeclared actions', async () => {
    const res = await h.request('POST', '/v1/actions/not-a-real-action', {})
    expect(res.status).toBe(404)
  })
})
