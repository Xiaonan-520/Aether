/**
 * Error-kind mapping tests — every protocol kind must be reachable and carry a
 * credential-free message and a sensible HTTP status.
 */
import { describe, expect, it } from 'vitest'
import {
  errors, ProtocolError, isProtocolErrorKind, kindForUpstreamStatus, UPSTREAM_ERROR_KINDS,
} from '../../src/protocol/errors.js'

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
