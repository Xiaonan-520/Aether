/**
 * Error-kind mapping tests — every protocol kind must be reachable and carry a
 * credential-free message and a sensible HTTP status.
 */
import { describe, expect, it } from 'vitest'
import {
  errors, ProtocolError, isProtocolErrorKind, kindForUpstreamStatus, UPSTREAM_ERROR_KINDS,
} from '../../src/protocol/errors.js'
import { upstreamError, parseRetryAfterMs } from '../../src/provider/workbuddycn/chat.js'

describe('protocol error mapping', () => {
  it('exposes exactly the Gateway UpstreamErrorKind vocabulary + PROTOCOL_VIOLATION', () => {
    expect([...UPSTREAM_ERROR_KINDS]).toEqual([
      'AUTH_INVALID', 'TOKEN_EXPIRED', 'RATE_LIMIT', 'QUOTA_EXHAUSTED', 'TIMEOUT',
      'TRANSPORT', 'UPSTREAM_5XX', 'TERMINAL', 'EMPTY_RESPONSE', 'NEEDS_CAPTCHA', 'NEEDS_MANUAL',
    ])
    expect(isProtocolErrorKind('PROTOCOL_VIOLATION')).toBe(true)
    expect(isProtocolErrorKind('NOPE')).toBe(false)
  })

  it('maps upstream HTTP statuses to kinds', () => {
    expect(kindForUpstreamStatus(401)).toBe('AUTH_INVALID')
    expect(kindForUpstreamStatus(403)).toBe('AUTH_INVALID')
    expect(kindForUpstreamStatus(429)).toBe('RATE_LIMIT')
    expect(kindForUpstreamStatus(500)).toBe('UPSTREAM_5XX')
    expect(kindForUpstreamStatus(503)).toBe('UPSTREAM_5XX')
    expect(kindForUpstreamStatus(400)).toBe('TERMINAL')
    expect(kindForUpstreamStatus(404)).toBe('TERMINAL')
  })

  it('every kind produces a well-formed body with a default retryable flag', () => {
    const all = [
      errors.authInvalid(), errors.tokenExpired(), errors.rateLimit(), errors.quotaExhausted(),
      errors.timeout(), errors.transport(), errors.upstream5xx(), errors.terminal(),
      errors.emptyResponse(), errors.needsCaptcha(), errors.needsManual(), errors.protocolViolation(),
    ]
    for (const e of all) {
      const body = e.toBody()
      expect(typeof body.error.kind).toBe('string')
      expect(typeof body.error.message).toBe('string')
      expect(body.error.message.length).toBeGreaterThan(0)
      expect(typeof body.error.retryable).toBe('boolean')
      expect(e.status()).toBeGreaterThanOrEqual(400)
      expect(e.status()).toBeLessThan(600)
    }
    expect(errors.rateLimit().toBody().error.retryable).toBe(true)
    expect(errors.authInvalid().toBody().error.retryable).toBe(false)
    expect(errors.needsManual().toBody().error.retryable).toBe(false)
  })

  it('uses responseStatus for protocol situations and ignores upstream httpStatus', () => {
    const unknown = new ProtocolError('TERMINAL', 'unknown account', { responseStatus: 404 })
    expect(unknown.status()).toBe(404)
    const upstream5xx = new ProtocolError('UPSTREAM_5XX', 'up', { httpStatus: 503 })
    expect(upstream5xx.status()).toBe(502) // kind canonical, not the upstream code
    expect(upstream5xx.httpStatus).toBe(503) // still recorded as metadata
  })

  it('does not treat arbitrary thrown values as credential leaks', () => {
    const e = errors.authInvalid('upstream rejected the credential')
    const serialized = JSON.stringify(e.toBody())
    expect(serialized).not.toMatch(/access_token|refresh_token|eyJ[A-Za-z0-9_-]+/)
  })
})

describe('WorkBuddyCN upstream error classification', () => {
  const body = (message: string, code = 400): string => JSON.stringify({ code, message })

  it('maps usage/quota exhaustion to QUOTA_EXHAUSTED (not a retryable rate limit)', () => {
    expect(upstreamError(400, body('使用量已超出')).kind).toBe('QUOTA_EXHAUSTED')
    expect(upstreamError(403, body('insufficient quota')).kind).toBe('QUOTA_EXHAUSTED')
    expect(upstreamError(400, body('usage exceeds the plan limit')).kind).toBe('QUOTA_EXHAUSTED')
  })

  it('keeps frequency/rate-limit messages as RATE_LIMIT', () => {
    expect(upstreamError(400, body('频率限制', 6004)).kind).toBe('RATE_LIMIT')
    expect(upstreamError(429, body('too many requests')).kind).toBe('RATE_LIMIT')
  })

  it('does not turn an ordinary 400 into a retryable or account-level error', () => {
    const err = upstreamError(400, body('invalid parameter'))
    expect(err.kind).toBe('TERMINAL')
    expect(err.retryable).toBe(false)
  })
})

describe('WorkBuddyCN Retry-After parsing', () => {
  const NOW = Date.parse('2026-10-25T00:00:00Z')

  it('parses delay-seconds', () => {
    expect(parseRetryAfterMs('120', NOW)).toBe(120_000)
    expect(parseRetryAfterMs('0', NOW)).toBe(0)
    expect(parseRetryAfterMs('1', NOW)).toBe(1_000)
  })

  it('parses an HTTP-date relative to now', () => {
    const future = new Date(NOW + 45_000).toUTCString()
    expect(parseRetryAfterMs(future, NOW)).toBe(45_000)
  })

  it('treats a past HTTP-date as retry immediately', () => {
    const past = new Date(NOW - 60_000).toUTCString()
    expect(parseRetryAfterMs(past, NOW)).toBe(0)
  })

  it('returns undefined for missing, empty, malformed and negative values', () => {
    expect(parseRetryAfterMs(null, NOW)).toBeUndefined()
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined()
    expect(parseRetryAfterMs('', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('   ', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('abc', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('-30', NOW)).toBeUndefined()
    expect(parseRetryAfterMs('1.5', NOW)).toBeUndefined()
  })

  it('clamps an absurd delay to a bounded cooldown', () => {
    expect(parseRetryAfterMs(String(30 * 24 * 3600), NOW)).toBe(6 * 60 * 60 * 1000)
  })

  it('forwards Retry-After only on rate-limit errors', () => {
    const limited = upstreamError(429, JSON.stringify({ code: 6004, msg: '频率限制' }), 90_000)
    expect(limited.kind).toBe('RATE_LIMIT')
    expect(limited.retryAfterMs).toBe(90_000)
    expect(limited.toBody().error.retryAfterMs).toBe(90_000)

    const quota = upstreamError(429, JSON.stringify({ msg: '使用量已超出' }), 90_000)
    expect(quota.kind).toBe('QUOTA_EXHAUSTED')
    expect(quota.retryAfterMs).toBeUndefined()

    const auth = upstreamError(403, JSON.stringify({ msg: 'forbidden' }), 90_000)
    expect(auth.kind).toBe('AUTH_INVALID')
    expect(auth.retryAfterMs).toBeUndefined()
  })

  it('omits retryAfterMs when the header was absent', () => {
    const limited = upstreamError(429, JSON.stringify({ msg: 'rate limit' }))
    expect(limited.kind).toBe('RATE_LIMIT')
    expect(limited.retryAfterMs).toBeUndefined()
    expect(limited.toBody().error).not.toHaveProperty('retryAfterMs')
  })
})
