import { describe, expect, it } from 'vitest'
import {
  accountStatus,
  rollUpAccounts,
  formatQuota,
  formatTime,
  formatReset,
  installState,
  runtimeState,
  healthState,
  extensionNextAction,
} from './status'

describe('status — accountStatus mapping', () => {
  it('maps every known AccountStatus to a label and severity', () => {
    expect(accountStatus('active')).toEqual({ label: 'Available', severity: 'ok' })
    expect(accountStatus('healthy_low_quota').severity).toBe('warn')
    expect(accountStatus('rate_limited').severity).toBe('warn')
    expect(accountStatus('cooldown').severity).toBe('warn')
    expect(accountStatus('token_expired').severity).toBe('auth')
    expect(accountStatus('auth_failed').severity).toBe('auth')
    expect(accountStatus('needs_manual_action').severity).toBe('auth')
    expect(accountStatus('quota_exhausted').severity).toBe('exhausted')
    expect(accountStatus('disabled')).toEqual({ label: 'Disabled', severity: 'neutral' })
  })

  it('falls back to the raw status for unknown values (forward compatibility)', () => {
    const view = accountStatus('brand_new_status' as never)
    expect(view).toEqual({ label: 'brand_new_status', severity: 'neutral' })
  })
})

describe('status — rollUpAccounts', () => {
  const base = { total: 2, available: 2, needsAttention: 0 }
  it('healthy only when some account is actually available', () => {
    expect(rollUpAccounts(base)).toEqual({ label: 'Healthy', severity: 'ok' })
  })
  it('degraded when available but some account needs attention', () => {
    expect(rollUpAccounts({ ...base, needsAttention: 1 })).toEqual({
      label: 'Degraded',
      severity: 'warn',
    })
  })
  it('needs attention when nothing is available', () => {
    expect(rollUpAccounts({ ...base, available: 0, needsAttention: 2 })).toEqual({
      label: 'Needs attention',
      severity: 'error',
    })
  })
  it('not ready when zero accounts and no attention flags (e.g. all disabled)', () => {
    expect(rollUpAccounts({ ...base, available: 0, needsAttention: 0 })).toEqual({
      label: 'Not ready',
      severity: 'warn',
    })
  })
  it('no accounts is neutral, never an error', () => {
    expect(rollUpAccounts({ total: 0, available: 0, needsAttention: 0 })).toEqual({
      label: 'No accounts',
      severity: 'neutral',
    })
  })
})

describe('status — formatQuota keeps unknown distinct from zero', () => {
  it('null/null is Unknown', () => {
    expect(formatQuota(null, null)).toEqual({ value: 'Unknown', unknown: true })
  })
  it('remaining null but total known renders ? / total', () => {
    expect(formatQuota(null, 100)).toEqual({ value: '? / 100', unknown: true })
  })
  it('real zero is rendered as zero, not unknown', () => {
    expect(formatQuota(0, 100)).toEqual({ value: '0 / 100', unknown: false })
    expect(formatQuota(0, null)).toEqual({ value: '0', unknown: false })
  })
  it('both known renders n / m', () => {
    expect(formatQuota(42, 100)).toEqual({ value: '42 / 100', unknown: false })
  })
})

describe('status — time formatting', () => {
  const now = 1_700_000_000_000
  it('renders null as an em dash', () => {
    expect(formatTime(null, now)).toBe('—')
  })
  it('renders recent times relatively', () => {
    expect(formatTime(now - 30_000, now)).toBe('just now')
    expect(formatTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatTime(now - 3 * 3_600_000, now)).toBe('3h ago')
  })
  it('renders future timestamps without negative relative strings', () => {
    expect(formatTime(now + 120_000, now)).not.toMatch(/ago/)
  })
  it('formatReset distinguishes no-info / due / future', () => {
    const realNow = Date.now()
    expect(formatReset(null)).toBe('no reset info')
    expect(formatReset(0)).toBe('no reset info')
    expect(formatReset(realNow - 1000)).toBe('reset due')
    // 500ms margin: floor() makes a plain +5m flaky when the test itself takes >0ms
    expect(formatReset(realNow + 5 * 60_000 + 500)).toBe('resets in 5m')
  })
})

describe('status — extension lifecycle labels', () => {
  it('uses operator-facing Chinese labels for the three dimensions', () => {
    expect(installState('installed')).toEqual({ label: '已安装', severity: 'ok' })
    expect(installState('failed')).toEqual({ label: '安装或启动失败', severity: 'error' })
    expect(runtimeState('running')).toEqual({ label: '运行中', severity: 'ok' })
    expect(runtimeState('unreachable')).toEqual({ label: '无法连接', severity: 'error' })
    expect(healthState('degraded')).toEqual({ label: '部分异常', severity: 'warn' })
  })

  it('degrades unknown values to 未知 instead of leaking raw state tokens', () => {
    expect(installState('conformance_pending_v9')).toEqual({ label: '未知', severity: 'neutral' })
    expect(runtimeState(undefined)).toEqual({ label: '未知', severity: 'neutral' })
    expect(healthState(null)).toEqual({ label: '未知', severity: 'neutral' })
  })

  it('derives the primary next action from the three states', () => {
    expect(
      extensionNextAction({ installState: 'stopped', runtimeState: 'stopped', providersRegistered: false }),
    ).toBe('start')
    expect(
      extensionNextAction({ installState: 'installed', runtimeState: 'running', providersRegistered: false }),
    ).toBe('reload')
    expect(
      extensionNextAction({ installState: 'installed', runtimeState: 'running', providersRegistered: true }),
    ).toBe('none')
  })
})
