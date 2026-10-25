/**
 * Status semantics shared by the console. These mappings are the single
 * source of truth for how account/provider states are presented — they never
 * conflate "authenticated" with "usable", or "claim enabled" with "claim
 * succeeded".
 */
import type { AccountStatus } from './api'

export type Severity = 'ok' | 'warn' | 'error' | 'auth' | 'exhausted' | 'neutral'

export interface StatusView {
  label: string
  severity: Severity
}

export const ACCOUNT_STATUS: Record<AccountStatus, StatusView> = {
  active: { label: 'Available', severity: 'ok' },
  healthy_low_quota: { label: 'Low quota', severity: 'warn' },
  rate_limited: { label: 'Rate limited', severity: 'warn' },
  cooldown: { label: 'Cooldown', severity: 'warn' },
  token_expired: { label: 'Token expired', severity: 'auth' },
  auth_failed: { label: 'Auth failed', severity: 'auth' },
  needs_manual_action: { label: 'Manual action', severity: 'auth' },
  quota_exhausted: { label: 'Quota exhausted', severity: 'exhausted' },
  disabled: { label: 'Disabled', severity: 'neutral' },
}

export function accountStatus(status: AccountStatus): StatusView {
  return ACCOUNT_STATUS[status] ?? { label: status, severity: 'neutral' }
}

/**
 * Roll an account list up to one severity for the provider card. Unknown or
 * mixed states surface as "attention" rather than masquerading as healthy.
 */
export function rollUpAccounts(accounts: {
  total: number
  available: number
  needsAttention: number
}): StatusView {
  if (accounts.total === 0) return { label: 'No accounts', severity: 'neutral' }
  if (accounts.available > 0) {
    return accounts.needsAttention > 0
      ? { label: 'Degraded', severity: 'warn' }
      : { label: 'Healthy', severity: 'ok' }
  }
  if (accounts.needsAttention > 0) return { label: 'Needs attention', severity: 'error' }
  return { label: 'Not ready', severity: 'warn' }
}

export const SEVERITY_CLASS: Record<Severity, string> = {
  ok: 'bg-success/12 text-success border-success/25',
  warn: 'bg-warning/12 text-warning border-warning/25',
  error: 'bg-destructive/12 text-destructive border-destructive/25',
  auth: 'bg-info/12 text-info border-info/25',
  exhausted: 'bg-destructive/12 text-destructive border-destructive/25',
  neutral: 'bg-muted text-muted-foreground border-border',
}

export function severityDot(severity: Severity): string {
  switch (severity) {
    case 'ok':
      return 'bg-success'
    case 'warn':
      return 'bg-warning'
    case 'error':
    case 'exhausted':
      return 'bg-destructive'
    case 'auth':
      return 'bg-info'
    default:
      return 'bg-muted-foreground/50'
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers (timezone-explicit, "unknown" never rendered as a value)
// ---------------------------------------------------------------------------

export function formatTime(ts: number | null | undefined, now = Date.now()): string {
  if (ts === null || ts === undefined) return '—'
  const diff = now - ts
  if (diff >= 0 && diff < 60_000) return 'just now'
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const d = new Date(ts)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatReset(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || ts === 0) return 'no reset info'
  const diff = ts - Date.now()
  if (diff <= 0) return 'reset due'
  if (diff < 3_600_000) return `resets in ${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `resets in ${Math.floor(diff / 3_600_000)}h`
  return `resets in ${Math.floor(diff / 86_400_000)}d`
}

/** "2 of 3" quota rendering that keeps null distinct from 0. */
export function formatQuota(
  remaining: number | null,
  total: number | null,
): { value: string; unknown: boolean } {
  if (remaining === null && total === null) return { value: 'Unknown', unknown: true }
  if (remaining === null) return { value: `? / ${total}`, unknown: true }
  if (total === null) return { value: String(remaining), unknown: false }
  return { value: `${remaining} / ${total}`, unknown: false }
}

// ---------------------------------------------------------------------------
// Extension lifecycle status (docs/EXTENSION_LIFECYCLE.md §2): install /
// runtime / health are three DIFFERENT dimensions and never collapsed into
// one badge. Severity follows the account palette.
// ---------------------------------------------------------------------------

import type { HealthState, InstallState, RuntimeState } from './api'

export const INSTALL_STATE: Record<InstallState, StatusView> = {
  pending: { label: '等待安装', severity: 'neutral' },
  validating: { label: '正在检查', severity: 'warn' },
  pulling: { label: '正在下载', severity: 'warn' },
  starting: { label: '正在启动', severity: 'warn' },
  health_check: { label: '正在检查运行状态', severity: 'warn' },
  conformance: { label: '正在验证扩展', severity: 'warn' },
  registering: { label: '正在接入', severity: 'warn' },
  installed: { label: '已安装', severity: 'ok' },
  stopped: { label: '已停止', severity: 'neutral' },
  failed: { label: '安装或启动失败', severity: 'error' },
  removing: { label: '正在移除', severity: 'warn' },
}

export const RUNTIME_STATE: Record<RuntimeState, StatusView> = {
  running: { label: '运行中', severity: 'ok' },
  stopped: { label: '未运行', severity: 'neutral' },
  unreachable: { label: '无法连接', severity: 'error' },
  unknown: { label: '未知', severity: 'neutral' },
}

export const HEALTH_STATE: Record<HealthState, StatusView> = {
  healthy: { label: '正常', severity: 'ok' },
  degraded: { label: '部分异常', severity: 'warn' },
  unknown: { label: '未知', severity: 'neutral' },
}

const UNKNOWN_EXTENSION_STATE: StatusView = { label: '未知', severity: 'neutral' }

export function installState(s: InstallState | string | null | undefined): StatusView {
  return (s ? INSTALL_STATE[s as InstallState] : undefined) ?? UNKNOWN_EXTENSION_STATE
}

export function runtimeState(s: RuntimeState | string | null | undefined): StatusView {
  return (s ? RUNTIME_STATE[s as RuntimeState] : undefined) ?? UNKNOWN_EXTENSION_STATE
}

export function healthState(s: HealthState | string | null | undefined): StatusView {
  return (s ? HEALTH_STATE[s as HealthState] : undefined) ?? UNKNOWN_EXTENSION_STATE
}

/**
 * What the operator should do next — drives the primary lifecycle button.
 * Derived from the three states, never from provider-specific knowledge.
 */
export function extensionNextAction(v: {
  installState: InstallState | string
  runtimeState: RuntimeState | string
  providersRegistered: boolean
}): 'start' | 'reload' | 'none' {
  if (v.installState === 'stopped' || v.runtimeState === 'stopped') return 'start'
  if (v.installState === 'installed' && v.runtimeState === 'running' && !v.providersRegistered) return 'reload'
  return 'none'
}
