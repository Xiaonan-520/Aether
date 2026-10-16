/**
 * WorkBuddy (Tencent CodeBuddy China) upstream API surface.
 *
 * Extracted strictly from the `buddy` provider of
 * iJetLi/deepseek-harness-codearts (see docs/UPSTREAM_RESEARCH.md). Only the
 * China-mainland product (platform `ide`, endpoint copilot.tencent.com) is
 * implemented here.
 */

export const API_ENDPOINT = 'https://www.workbuddy.ai'
export const API_DOMAIN = 'www.workbuddy.ai'
export const WEBSITE_HOME = 'https://www.workbuddy.ai'
export const PLATFORM = 'workbuddy-ai'

export const AUTH_STATE_PATH = '/v2/plugin/auth/state'
export const AUTH_TOKEN_PATH = '/v2/plugin/auth/token'
export const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account'
export const AUTH_REFRESH_PATH = '/v2/plugin/auth/token/refresh'
export const CONFIG_PATH = '/v3/config'
export const CHAT_PATH = '/v2/chat/completions'
export const USER_RESOURCE_PATH = '/v2/billing/meter/get-user-resource'
export const CHECKIN_ACTIVITY_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
export const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin'

/** Personal-account scope literal for the scoped model catalog endpoint. */
export const ENTERPRISE_MODELS_SCOPE = 'personal'
export const SCOPED_MODELS_PATH = `/console/enterprises/${ENTERPRISE_MODELS_SCOPE}/models`

// ── header names ───────────────────────────────────────────────
export const H_DOMAIN = 'X-Domain'
export const H_ENTERPRISE_ID = 'X-Enterprise-Id'
export const H_TENANT_ID = 'X-Tenant-Id'
export const H_NO_AUTHORIZATION = 'X-No-Authorization'
export const H_NO_USER_ID = 'X-No-User-Id'
export const H_NO_ENTERPRISE_ID = 'X-No-Enterprise-Id'
export const H_NO_DEPARTMENT_INFO = 'X-No-Department-Info'
export const H_REFRESH_TOKEN = 'X-Refresh-Token'
export const H_AUTH_REFRESH_SOURCE = 'X-Auth-Refresh-Source'
export const H_PRODUCT = 'X-Product'
export const H_PRODUCT_CODE = 'X-Product-Code'
export const H_USER_ID = 'X-User-Id'

export const AUTH_REFRESH_SOURCE = 'ide-main'
export const BUDDY_DEPLOYMENT_TYPE = 'SaaS'
export const BUDDY_USER_AGENT = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2'
export const BUDDY_PRODUCT_CODE = 'workbuddy'

// ── polling / timeout constants ────────────────────────────────
/** Login polling total budget. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
export const POLL_INTERVAL_MS = 1000
export const STATE_REQUEST_TIMEOUT_MS = 10_000
export const REQUEST_TIMEOUT_MS = 60_000

// ── business error codes ───────────────────────────────────────
export const CODE_TOKEN_NOT_READY = 11217
export const CODE_ACCOUNT_NOT_READY = 12151

// ── static default chat-capable models (live-discovery fallback only) ──
export const DEFAULT_MODELS: readonly string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'hy4-preview',
  'hy4-preview-x',
  'hy3',
  'hy3-x',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'glm-5.1',
  'glm-5v-turbo',
  'kimi-k3-1',
  'kimi-k2.7',
  'kimi-k2.6',
  'minimax-m3',
]

export const DEFAULT_MODEL = 'deepseek-v4-flash'

/** Fallback context windows (used only when live discovery is unavailable). */
export const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map(
  DEFAULT_MODELS.map((id) => [
    id,
    {
      'deepseek-v4-flash': 1_000_000,
      'deepseek-v4-pro': 1_000_000,
      'hy4-preview': 1_000_000,
      'hy4-preview-x': 1_000_000,
      'hy3': 192_000,
      'hy3-x': 192_000,
      'glm-5.3': 1_000_000,
      'glm-5.3-flash': 1_000_000,
      'glm-5.2': 1_000_000,
      'glm-5.1': 200_000,
      'glm-5v-turbo': 200_000,
      'kimi-k3-1': 1_000_000,
      'kimi-k2.7': 256_000,
      'kimi-k2.6': 256_000,
      'minimax-m3': 512_000,
    }[id]!,
  ]),
)

export const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'hy4-preview': 'Hy4 Preview',
  'hy4-preview-x': 'Hy4 Preview X',
  'hy4-preview-f': 'Hy4 Preview F',
  'hy3': 'Hy3',
  'hy3-x': 'Hy3 X',
  'glm-5.3': 'GLM-5.3',
  'glm-5.3-flash': 'GLM-5.3 Flash',
  'glm-5.2': 'GLM-5.2',
  'glm-5.1': 'GLM-5.1',
  'glm-5v-turbo': 'GLM-5V Turbo',
  'kimi-k3-1': 'Kimi K3-1',
  'kimi-k2.7': 'Kimi K2.7',
  'kimi-k2.6': 'Kimi K2.6',
  'minimax-m3': 'MiniMax M3',
}