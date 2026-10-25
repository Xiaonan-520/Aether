/**
 * Operator-facing translations for extension failures.
 *
 * The core/manager messages are written for operators who read logs; they
 * routinely contain container addresses, manifest jargon and HTTP details.
 * The console shows a short explanation plus a next step, and keeps the raw
 * message behind a collapsed "technical details" block so a real failure is
 * never hidden.
 */
import { ApiError } from './api'

export interface ErrorExplanation {
  /** one short sentence: what happened */
  summary: string
  /** what the user can do next */
  hint: string
  /** raw server/exception message; rendered only behind a details toggle */
  detail: string | null
}

type ErrorContext = 'load' | 'install' | 'operation'

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return ''
}

function explain(
  summary: string,
  hint: string,
  detail: string,
): ErrorExplanation {
  return { summary, hint, detail: detail.trim() === '' ? null : detail }
}

/** Classify an API/network failure for display. */
export function describeExtensionError(
  error: unknown,
  context: ErrorContext = 'operation',
): ErrorExplanation {
  const detail = rawMessage(error)
  const text = detail.toLowerCase()
  const status = error instanceof ApiError ? error.status : null

  if (status === 0 || /network error|fetch failed|failed to fetch/.test(text)) {
    return explain('无法连接到网关。', '请确认网关正在运行，然后重试。', detail)
  }
  if (status === 401) {
    return explain('登录已过期。', '请重新登录后再试。', detail)
  }
  if (status === 404) {
    return context === 'load'
      ? explain(
          '找不到这个扩展。',
          '它可能尚未安装，或已经被移除。返回扩展列表可以查看当前已安装的扩展。',
          detail,
        )
      : explain('找不到这个扩展。', '请返回扩展列表刷新后再试。', detail)
  }
  if (status === 409 || /operation_in_progress|is busy/.test(text)) {
    return explain(
      '扩展正在执行其他操作。',
      '请等待当前操作完成，然后重试。',
      detail,
    )
  }
  if (status === 503 || /manager_unavailable|extension manager unreachable/.test(text)) {
    return explain(
      '扩展服务暂时不可用。',
      '请稍后重试。如果一直失败，请确认扩展管理服务正在运行。',
      detail,
    )
  }
  if (status === 502 || /manager_error|manager_auth_misconfigured/.test(text)) {
    return explain(
      '扩展服务返回了错误。',
      '请稍后重试。如果一直失败，请把技术详情提供给管理员。',
      detail,
    )
  }
  if (context === 'install' && /manifest|conformance|forbidden_image_source|trusted image|tag/.test(text)) {
    return explain(
      '扩展包不符合安装要求。',
      '请确认扩展包地址和版本号正确，且版本号与扩展提供方给出的一致，然后重试。',
      detail,
    )
  }
  if (/health check|health_check|did not become healthy/.test(text)) {
    return explain(
      '扩展没有正常启动。',
      '请尝试重启扩展。如果仍然失败，请把技术详情提供给管理员。',
      detail,
    )
  }

  return explain(
    context === 'load' ? '无法加载扩展信息。' : '操作没有完成。',
    '请稍后重试。如果反复失败，请把技术详情提供给管理员。',
    detail,
  )
}

/**
 * Translate the raw `lastError` persisted on an extension record. That string
 * is written by the manager and is often a wrapped health-check/manager error.
 */
export function describeStoredError(message: string): ErrorExplanation {
  const text = message.toLowerCase()
  if (/econnrefused|connection refused|connect etimedout|timeout|timed out|unreachable|no route to host/.test(text)) {
    return explain(
      '扩展服务无法连接。',
      '扩展可能没有运行。请尝试「启动」或「重启」；如果仍然失败，请查看技术详情。',
      message,
    )
  }
  if (/health/.test(text)) {
    return explain(
      '扩展未通过健康检查。',
      '请尝试重启扩展；如果仍然失败，请查看技术详情。',
      message,
    )
  }
  if (/manifest|conformance|version|tag/.test(text)) {
    return explain(
      '扩展的安装信息不一致。',
      '请重新安装该扩展；如果仍然失败，请查看技术详情。',
      message,
    )
  }
  if (/token|unauthorized|401|403/.test(text)) {
    return explain(
      '扩展与网关之间的认证失败。',
      '请尝试「重载服务」；如果仍然失败，请查看技术详情。',
      message,
    )
  }
  return explain(
    '扩展上次运行时出错。',
    '可以尝试重启或重新安装该扩展；如果仍然失败，请查看技术详情。',
    message,
  )
}
