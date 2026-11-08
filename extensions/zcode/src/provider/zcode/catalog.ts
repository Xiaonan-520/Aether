/**
 * ZCode 静态目录：上游端点 + 模型表。
 * 与 Core 内置适配器（src/providers/zcode/auth.ts）完全同源。
 */

export const ZCODE_API_BASE = 'https://zcode.z.ai/api/v1'

export const ZCODE_UPSTREAM = {
  /** coding-plan 端点（zcodejwttoken 鉴权） */
  codingPlan: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',
  /** 经典 API-key 端点 */
  apiKey: 'https://api.z.ai/api/anthropic/v1/messages',
} as const

export const ZCODE_QUOTA = {
  billing: `${ZCODE_API_BASE}/zcode-plan/billing/current`,
  balance: `${ZCODE_API_BASE}/zcode-plan/billing/balance`,
  usage: `${ZCODE_API_BASE}/zcode-plan/usage`,
} as const

export const ZCODE_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5.1', name: 'GLM-5.1' },
  { id: 'glm-5-turbo', name: 'GLM-5 Turbo' },
  { id: 'glm-4.7', name: 'GLM-4.7' },
]

/** 上游对模型名大小写敏感 */
export const MODEL_NAME_MAP: Readonly<Record<string, string>> = {
  'glm-5.2': 'GLM-5.2',
  'glm-5.1': 'GLM-5.1',
  'glm-5-turbo': 'GLM-5-Turbo',
  'glm-4.7': 'GLM-4.7',
}

export function bareModel(model: string): string {
  const sep = model.indexOf('::')
  return sep > 0 ? model.slice(sep + 2) : model
}

/**
 * 鉴权头与上游端点的选择。
 * JWT（coding-plan）优先；无 JWT 时回落 api_key（x-api-key 形态）。
 */
export function authHeaders(credential: { jwt_token?: string; api_key?: string }): Record<string, string> {
  if (credential.jwt_token) return { Authorization: `Bearer ${credential.jwt_token}` }
  if (credential.api_key) return { 'x-api-key': credential.api_key }
  throw new Error('zcode: no usable credential (jwt_token or api_key required)')
}

export function upstreamFor(credential: { jwt_token?: string; api_key?: string }, apiBase = ZCODE_API_BASE): string {
  // coding-plan 端点跟随 apiBase（可测试注入）；API-key 端点固定在 api.z.ai
  return credential.jwt_token ? `${apiBase}/zcode-plan/anthropic/v1/messages` : ZCODE_UPSTREAM.apiKey
}
