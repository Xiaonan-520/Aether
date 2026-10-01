import { describe, expect, it } from 'vitest'
import {
  normalizeFailure,
  normalizeThrown,
  registerBusinessCodes,
  toOpenAiStatus,
  toOpenAiErrorBody,
  extractBusinessCode,
} from '../src/core/errors/normalizer.js'
import { UpstreamError } from '../src/core/errors/upstream-error.js'

const ctx = { provider: 'codearts' }

describe('normalizeFailure — http', () => {
  it('401/403 → AUTH_INVALID', () => {
    expect(normalizeFailure({ type: 'http', status: 401 }, ctx).kind).toBe('AUTH_INVALID')
    expect(normalizeFailure({ type: 'http', status: 403 }, ctx).kind).toBe('AUTH_INVALID')
  })

  it('429 → RATE_LIMIT with retry-after', () => {
    const err = normalizeFailure({ type: 'http', status: 429, retryAfterSeconds: 30 }, ctx)
    expect(err.kind).toBe('RATE_LIMIT')
    expect(err.retryAfterMs).toBe(30_000)
  })

  it('5xx → UPSTREAM_5XX, 4xx → TERMINAL', () => {
    expect(normalizeFailure({ type: 'http', status: 502 }, ctx).kind).toBe('UPSTREAM_5XX')
    expect(normalizeFailure({ type: 'http', status: 400 }, ctx).kind).toBe('TERMINAL')
  })

  it('provider business codes refine the kind', () => {
    registerBusinessCodes('codearts', (code) => {
      if (code === '81111') return 'RATE_LIMIT'
      if (code === '1005') return 'QUOTA_EXHAUSTED'
      return undefined
    })
    const body = '{"code":1005,"message":"insufficient balance"}'
    expect(normalizeFailure({ type: 'http', status: 400, bodySnippet: body }, ctx).kind)
      .toBe('QUOTA_EXHAUSTED')
    expect(normalizeFailure({ type: 'http', status: 400, bodySnippet: '{"code":81111}' }, ctx).kind)
      .toBe('RATE_LIMIT')
  })
})

describe('normalizeFailure — network', () => {
  it('ENOTFOUND/ECONNREFUSED → TRANSPORT', () => {
    expect(normalizeFailure({ type: 'network', code: 'ENOTFOUND', message: 'dns' }, ctx).kind)
      .toBe('TRANSPORT')
  })

  it('ETIMEDOUT → TIMEOUT', () => {
    expect(normalizeFailure({ type: 'network', code: 'ETIMEDOUT', message: 'timed out' }, ctx).kind)
      .toBe('TIMEOUT')
  })
})

describe('normalizeThrown', () => {
  it('passes UpstreamError through', () => {
    const original = new UpstreamError({ kind: 'QUOTA_EXHAUSTED', message: 'x' })
    expect(normalizeThrown(original, ctx)).toBe(original)
  })

  it('AbortError → TIMEOUT', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(normalizeThrown(abort, ctx).kind).toBe('TIMEOUT')
  })

  it('errno errors → TRANSPORT', () => {
    const e = new Error('connect failed') as NodeJS.ErrnoException
    e.code = 'ECONNREFUSED'
    expect(normalizeThrown(e, ctx).kind).toBe('TRANSPORT')
  })

  it('non-Error values → TERMINAL', () => {
    expect(normalizeThrown('boom', ctx).kind).toBe('TERMINAL')
  })
})

describe('outbound mapping', () => {
  it('toOpenAiStatus maps kinds to client-facing statuses', () => {
    const mk = (kind: UpstreamError['kind']) =>
      new UpstreamError({ kind, message: 'x' })
    expect(toOpenAiStatus(mk('AUTH_INVALID'))).toBe(502)
    expect(toOpenAiStatus(mk('RATE_LIMIT'))).toBe(429)
    expect(toOpenAiStatus(mk('QUOTA_EXHAUSTED'))).toBe(503)
    expect(toOpenAiStatus(mk('NEEDS_CAPTCHA'))).toBe(503)
    expect(toOpenAiStatus(mk('TERMINAL'))).toBe(400)
    expect(toOpenAiStatus(mk('TRANSPORT'))).toBe(502)
  })

  it('error body exposes kind but no internals', () => {
    const body = toOpenAiErrorBody(new UpstreamError({ kind: 'NEEDS_MANUAL', message: 'needs human' }))
    expect(body.error).toMatchObject({ type: 'manual_action_required', code: 'needs_manual' })
    expect(JSON.stringify(body)).not.toContain('detail')
  })
})

describe('extractBusinessCode', () => {
  it('finds numeric and string codes', () => {
    expect(extractBusinessCode('{"code":1005}')).toBe('1005')
    expect(extractBusinessCode('{"code":"APIG.0602"}')).toBe('APIG.0602')
    expect(extractBusinessCode('no code here')).toBeUndefined()
    expect(extractBusinessCode(undefined)).toBeUndefined()
  })
})
