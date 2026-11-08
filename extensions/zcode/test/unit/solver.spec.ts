/**
 * happy-dom 求解器（src/solver/*）移植完整性的回归测试。
 *
 * 与 aether-extension 原型的测试同源，钉住移植时不能丢的行为：
 * 严格结果校验（拒绝降级 param）、SDK XHR 超时补丁、certifyId 去重、
 * 有界重试预算、CPU 治理快照。
 */
import { describe, expect, it } from 'vitest'
import { extractVerifyParam } from '../../src/solver/happy-solver.js'
import { patchSdkXhrTimeout, patchPeBundle } from '../../src/solver/happy-solver.js'
import { parseCertifyId, isDuplicateError, isIpBlockError } from '../../src/solver/token-pool.js'
import { withRetry, RetryBudgetExhaustedError } from '../../src/solver/retry.js'
import { CpuGovernor } from '../../src/solver/cpu-governor.js'

function makeParam(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

describe('solver: extractVerifyParam (degraded-result defence)', () => {
  it('accepts a legitimate param (securityToken >= 50 chars)', () => {
    const param = makeParam({
      certifyId: 'cid-abc', sceneId: '11xygtvd', isSign: true,
      securityToken: 'x'.repeat(120), padding: 'y'.repeat(120),
    })
    expect(param.length).toBeGreaterThan(200)
    expect(extractVerifyParam(param)).toBe(param)
  })

  it('rejects the degraded 76-char shape (would 3007 upstream)', () => {
    const degraded = makeParam({ certifyId: '70bdb', isSign: true })
    expect(degraded.length).toBeLessThan(200)
    expect(() => extractVerifyParam(degraded)).toThrow(/过短/)
  })

  it('rejects long-but-tokenless results', () => {
    const param = makeParam({ certifyId: 'cid', isSign: true, filler: 'z'.repeat(300) })
    expect(param.length).toBeGreaterThan(200)
    expect(() => extractVerifyParam(param)).toThrow(/securityToken/)
  })

  it('rejects non-base64-JSON junk', () => {
    expect(() => extractVerifyParam('A'.repeat(300))).toThrow()
    expect(() => extractVerifyParam(null)).toThrow(/空/)
  })

  it('extracts from object envelopes (verifyParam / data / param)', () => {
    const good = makeParam({ certifyId: 'cid', securityToken: 's'.repeat(120), filler: 'f'.repeat(120) })
    expect(extractVerifyParam({ verifyParam: good })).toBe(good)
    expect(extractVerifyParam({ data: good })).toBe(good)
    expect(extractVerifyParam({ param: good })).toBe(good)
  })

  it('is case-compatible with SecurityToken', () => {
    const param = makeParam({ certifyId: 'cid', SecurityToken: 's'.repeat(120), filler: 'f'.repeat(120) })
    expect(extractVerifyParam(param)).toBe(param)
  })
})

describe('solver: SDK XHR timeout patch (F008 root cause)', () => {
  it('rewrites 5e3 → 30e3 in both bundles', () => {
    const src = Buffer.from('a=arguments[4]?arguments[4]:5e3;b=arguments[4]?arguments[4]:5e3;', 'utf8')
    expect(patchSdkXhrTimeout(src).toString('utf8').match(/30e3/g)?.length).toBe(2)
  })

  it('fail-open when the pattern is absent (SDK upgraded)', () => {
    expect(patchSdkXhrTimeout(Buffer.from('var x = 1;', 'utf8')).toString('utf8')).toBe('var x = 1;')
  })

  it('is idempotent (no 60e3 accumulation)', () => {
    const once = patchSdkXhrTimeout(Buffer.from('arguments[4]?arguments[4]:5e3', 'utf8'))
    const twice = patchPeBundle(once, 'https://x/pe.0.1.js').toString('utf8')
    expect(twice).toContain('30e3')
    expect(twice).not.toContain('60e3')
  })
})

describe('solver: certifyId registry (F008 prevention)', () => {
  it('parses certifyId from the wire param', () => {
    const param = Buffer.from(JSON.stringify({ certifyId: 'abc123' })).toString('base64')
    expect(parseCertifyId(param)).toBe('abc123')
    expect(parseCertifyId('junk')).toBeNull()
  })

  it('classifies duplicate and IP-block errors', () => {
    expect(isDuplicateError('verify rejected {verifyCode:F008}')).toBe(true)
    expect(isIpBlockError('too many captcha requests')).toBe(true)
    expect(isIpBlockError('normal timeout')).toBe(false)
  })
})

describe('solver: bounded retry', () => {
  it('exhausts the budget with a structured error', async () => {
    let calls = 0
    await expect(
      withRetry(async () => {
        calls += 1
        throw new Error('always')
      }, { maxAttempts: 3, baseDelayMs: 1, jitterMs: 0 }),
    ).rejects.toBeInstanceOf(RetryBudgetExhaustedError)
    expect(calls).toBe(3)
  })

  it('passes through when the call succeeds', async () => {
    const out = await withRetry(async () => 'ok', { baseDelayMs: 1 })
    expect(out).toBe('ok')
  })
})

describe('solver: CPU governor', () => {
  it('starts at max concurrency and reports a full snapshot', () => {
    const g = new CpuGovernor({
      limitPercent: 70, hysteresisPercent: 15, maxConcurrency: 3, minConcurrency: 1, intervalMs: 2_000,
    })
    expect(g.concurrency).toBe(3)
    const s = g.snapshot()
    expect(s).toHaveProperty('cpuPercent')
    expect(s).toHaveProperty('throttled')
    g.stop()
  })

  it('tick never throws on both /proc and os.cpus paths', async () => {
    const g = new CpuGovernor({
      limitPercent: 70, hysteresisPercent: 15, maxConcurrency: 3, minConcurrency: 1, intervalMs: 2_000,
    })
    await expect(g.tick()).resolves.toBeUndefined()
    await expect(g.tick()).resolves.toBeUndefined()
    g.stop()
  })
})
