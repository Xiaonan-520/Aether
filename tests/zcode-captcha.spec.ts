/**
 * ZCode captcha manager: cache/TTL, single-flight, invalidation, config fetch.
 *
 * The manager never solves a captcha; these tests assert the lifecycle only.
 */
import { describe, expect, it, vi } from 'vitest'
import { ZCodeCaptchaManager, ZCodeCaptchaUnavailableError } from '../src/providers/zcode/captcha.js'

describe('ZCodeCaptchaManager', () => {
  it('reports needs_manual_action when no token is cached', () => {
    const manager = new ZCodeCaptchaManager()
    expect(manager.isValid()).toBe(false)
    expect(() => manager.getToken()).toThrow(ZCodeCaptchaUnavailableError)
    try {
      manager.getToken()
    } catch (err) {
      expect((err as ZCodeCaptchaUnavailableError).kind).toBe('needs_manual_action')
    }
  })

  it('returns the submitted token until the TTL elapses', () => {
    let now = 1_000
    const manager = new ZCodeCaptchaManager({ cacheTtlMs: 45_000, now: () => now })
    manager.submit('verify-abc')
    expect(manager.getToken()).toBe('verify-abc')
    expect(manager.isValid()).toBe(true)

    now += 44_999
    expect(manager.isValid()).toBe(true)
    now += 2
    expect(manager.isValid()).toBe(false)
    expect(manager.peek()).toBeNull()
  })

  it('single-flights concurrent waiters onto one submission', async () => {
    const manager = new ZCodeCaptchaManager()
    const waiters = [manager.waitForToken(5_000), manager.waitForToken(5_000), manager.waitForToken(5_000)]
    // all three share one pending promise
    expect(waiters[0]).toBe(waiters[1])
    expect(waiters[1]).toBe(waiters[2])
    manager.submit('shared-token')
    await expect(Promise.all(waiters)).resolves.toEqual(['shared-token', 'shared-token', 'shared-token'])
  })

  it('resolves a waiter that starts after a token is already cached', async () => {
    const manager = new ZCodeCaptchaManager()
    manager.submit('cached')
    await expect(manager.waitForToken(100)).resolves.toBe('cached')
  })

  it('rejects waiters when the token never arrives', async () => {
    const manager = new ZCodeCaptchaManager()
    await expect(manager.waitForToken(10)).rejects.toBeInstanceOf(ZCodeCaptchaUnavailableError)
  })

  it('invalidates the cached token (403 path)', () => {
    const manager = new ZCodeCaptchaManager()
    manager.submit('tok')
    expect(manager.peek()).toBe('tok')
    manager.invalidate()
    expect(manager.peek()).toBeNull()
    expect(() => manager.getToken()).toThrow(ZCodeCaptchaUnavailableError)
  })

  it('rejects an empty submission', () => {
    const manager = new ZCodeCaptchaManager()
    expect(() => manager.submit('   ')).toThrow(/empty/)
  })

  it('parses the remote captcha config', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ data: { configs: { captcha: { enabled: true, prefix: 'px', region: 'cn', sceneId: 'sc' } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    const manager = new ZCodeCaptchaManager({ fetcher })
    await expect(manager.fetchConfig()).resolves.toEqual({ enabled: true, prefix: 'px', region: 'cn', sceneId: 'sc' })
  })

  it('falls back to defaults when the config fetch fails', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const manager = new ZCodeCaptchaManager({ fetcher })
    const config = await manager.fetchConfig()
    expect(config.prefix).toBe('no8xfe')
    expect(config.sceneId).toBe('11xygtvd')
  })

  it('caches the config for its TTL', async () => {
    let now = 0
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ data: { configs: { captcha: { prefix: 'p1', region: 'r', sceneId: 's' } } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    const manager = new ZCodeCaptchaManager({ fetcher, now: () => now, configTtlMs: 100 })
    await manager.fetchConfig()
    await manager.fetchConfig()
    expect(fetcher).toHaveBeenCalledTimes(1)
    now += 101
    await manager.fetchConfig()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
