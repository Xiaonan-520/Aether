/**
 * ZCode captcha module tests: challenge detection (header + in-body 3007),
 * config cache (positive/negative), handler chain and the authorize page.
 *
 * The module never solves a captcha programmatically; these tests assert the
 * detection/lifecycle contract only.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  detectCaptchaChallenge,
  isDuplicateVerifyError,
  isIpBlockError,
  classifyReject,
  CAPTCHA_VERIFY_HEADER,
} from '../src/providers/zcode/captcha/captcha-client.js'
import { CaptchaConfigCache, DEFAULT_CAPTCHA_CONFIG, widgetParams } from '../src/providers/zcode/captcha/captcha-config.js'
import {
  CaptchaHandlerChain,
  ManualCaptchaHandler,
  renderAuthorizePage,
} from '../src/providers/zcode/captcha/captcha-solver.js'
import { ZCodeCaptchaManager } from '../src/providers/zcode/captcha/manager.js'
import type { CaptchaHandler } from '../src/providers/zcode/captcha/types.js'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

describe('captcha challenge detection', () => {
  it('detects the response-header variant on a non-2xx response', async () => {
    const response = new Response('{"error":"denied"}', {
      status: 403,
      headers: { [CAPTCHA_VERIFY_HEADER]: 'param-1', 'content-type': 'application/json' },
    })
    const challenge = await detectCaptchaChallenge(response)
    expect(challenge).toMatchObject({ kind: 'rejected_403' })
  })

  it('does not flag 2xx responses carrying the header', async () => {
    const response = new Response('{}', {
      status: 200,
      headers: { [CAPTCHA_VERIFY_HEADER]: 'param-1' },
    })
    await expect(detectCaptchaChallenge(response)).resolves.toBeNull()
  })

  it('detects the in-body 3007 variant (compact JSON)', async () => {
    const challenge = await detectCaptchaChallenge(jsonResponse({ code: 3007, msg: 'captcha' }, 400))
    expect(challenge).toMatchObject({ kind: 'in_body_3007' })
  })

  it('detects the in-body 3007 variant (spaced JSON)', async () => {
    const response = new Response('{ "code": 3007, "msg": "x" }', { status: 400 })
    const challenge = await detectCaptchaChallenge(response)
    expect(challenge).toMatchObject({ kind: 'in_body_3007' })
  })

  it('ignores a plain 400 without the 3007 marker', async () => {
    const challenge = await detectCaptchaChallenge(jsonResponse({ code: 1001, msg: 'bad request' }, 400))
    expect(challenge).toBeNull()
  })

  it('skips SSE bodies', async () => {
    const response = new Response('data: {"code":3007}\n\n', {
      status: 400,
      headers: { 'content-type': 'text/event-stream' },
    })
    await expect(detectCaptchaChallenge(response)).resolves.toBeNull()
  })

  it('sniffs through gzip content-encoding', async () => {
    const gz = await (async () => {
      const stream = new Blob([JSON.stringify({ code: 3007 })]).stream().pipeThrough(new CompressionStream('gzip'))
      return await new Response(stream).arrayBuffer()
    })()
    const response = new Response(gz, {
      status: 400,
      headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
    })
    const challenge = await detectCaptchaChallenge(response)
    expect(challenge).toMatchObject({ kind: 'in_body_3007' })
  })

  it('classifies F008 duplicates and IP blocks distinctly', () => {
    expect(isDuplicateVerifyError('verifyCode: F008 - certifyId consumed')).toBe(true)
    expect(isIpBlockError('verifyCode: F008')).toBe(false)
    expect(isIpBlockError('too many captcha requests from this ip')).toBe(true)
    expect(classifyReject('F008')).toBe('duplicate')
    expect(classifyReject('risk control denied')).toBe('ip_block')
    expect(classifyReject('something else')).toBe('unknown')
  })
})

describe('captcha config cache', () => {
  it('parses the remote config and caches it for the TTL', async () => {
    let now = 0
    const fetcher = vi.fn(async () => jsonResponse({ data: { configs: { captcha: { prefix: 'px', region: 'cn', sceneId: 'sc' } } } }))
    const cache = new CaptchaConfigCache({ fetcher: fetcher as unknown as typeof fetch, now: () => now })
    await expect(cache.get()).resolves.toEqual({ enabled: true, prefix: 'px', region: 'cn', sceneId: 'sc' })
    now += 59_000
    await cache.get()
    expect(fetcher).toHaveBeenCalledTimes(1)
    now += 2_000
    await cache.get()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('falls back to defaults and applies the negative cache on failure', async () => {
    let now = 0
    const fetcher = vi.fn(async () => {
      throw new Error('offline')
    })
    const cache = new CaptchaConfigCache({ fetcher: fetcher as unknown as typeof fetch, now: () => now })
    await expect(cache.get()).resolves.toEqual(DEFAULT_CAPTCHA_CONFIG)
    await expect(cache.get()).resolves.toEqual(DEFAULT_CAPTCHA_CONFIG)
    expect(fetcher).toHaveBeenCalledTimes(1) // negative cache suppresses retries
    now += 16_000
    await cache.get()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('derives widget params with a CDN script URL', () => {
    const params = widgetParams({ enabled: true, prefix: 'p', region: 'sgp', sceneId: 's' })
    expect(params).toMatchObject({ prefix: 'p', region: 'sgp', sceneId: 's' })
    expect(params.scriptUrl).toContain('o.alicdn.com/captcha-frontend')
  })
})

describe('captcha handler chain', () => {
  it('manual handler serves a cached token and reports unavailable otherwise', async () => {
    const manager = new ZCodeCaptchaManager()
    const handler = new ManualCaptchaHandler(manager)
    await expect(handler.handle({ kind: 'initial' })).resolves.toEqual({ ok: false, reason: 'unavailable' })
    manager.submit('tok-1')
    await expect(handler.handle({ kind: 'rejected_403' })).resolves.toEqual({ ok: true, verifyParam: 'tok-1' })
    manager.invalidate()
    await expect(handler.handle({ kind: 'initial' })).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('falls through to the next handler when the first is unavailable', async () => {
    const fallback: CaptchaHandler = {
      id: 'fallback',
      handle: async () => ({ ok: true, verifyParam: 'from-fallback' }),
    }
    const chain = new CaptchaHandlerChain([new ManualCaptchaHandler(new ZCodeCaptchaManager()), fallback])
    await expect(chain.handle({ kind: 'initial' })).resolves.toEqual({ ok: true, verifyParam: 'from-fallback' })
  })

  it('reports unavailable when every handler fails', async () => {
    const chain = new CaptchaHandlerChain([new ManualCaptchaHandler(new ZCodeCaptchaManager())])
    await expect(chain.handle({ kind: 'in_body_3007' })).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('authorize page', () => {
  it('renders the official widget wiring with escaped params', () => {
    const html = renderAuthorizePage({
      prefix: 'no8xfe',
      region: 'sgp',
      sceneId: '11xygtvd',
      scriptUrl: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',
      submitPath: '/api/accounts/zcode/captcha',
    })
    expect(html).toContain('initAliyunCaptcha')
    // V3 contract: region/prefix go through the pre-load global, never init params
    expect(html).toContain('window.AliyunCaptchaConfig')
    expect(html).toContain("region: 'sgp'")
    expect(html).toContain("prefix: 'no8xfe'")
    expect(html).toContain("SceneId: '11xygtvd'")
    expect(html).toContain("mode: 'popup'")
    expect(html).toContain("button: '#btn'")
    expect(html).toContain('getInstance')
    expect(html).toContain('success:')
    expect(html).toContain('verify_param')
    expect(html).not.toContain('captchaVerifyCallback')
    expect(html).not.toContain('onBizError')
    expect(html).toContain('/api/accounts/zcode/captcha')
  })

  it('escapes hostile config values', () => {
    const html = renderAuthorizePage({
      prefix: "a'+" as string,
      region: 'sgp',
      sceneId: '<script>' as string,
      scriptUrl: 'https://x',
      submitPath: '/y',
    })
    expect(html).not.toContain("prefix: 'a'+")
    expect(html).toContain('&#39;')
    expect(html).not.toContain("SceneId: '<script>'")
    expect(html).toContain('SceneId: \'&lt;script&gt;\'')
  })

  it('keeps the AliyunCaptchaConfig global before the SDK script tag', () => {
    const html = renderAuthorizePage({
      prefix: 'no8xfe',
      region: 'sgp',
      sceneId: '11xygtvd',
      scriptUrl: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',
      submitPath: '/y',
    })
    expect(html.indexOf('window.AliyunCaptchaConfig')).toBeLessThan(
      html.indexOf('aliyunCaptcha/AliyunCaptcha.js'),
    )
  })
})
