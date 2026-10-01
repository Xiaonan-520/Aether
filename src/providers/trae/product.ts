/**
 * TRAE product configuration (字节跳动 TRAE IDE).
 *
 * TRAE CN and TRAE INTL are two independent clients: the protocol is identical
 * and only the hosts differ, so both providers share one adapter and differ only
 * by this config (same approach as the Buddy family).
 *
 * Verified values (jet-hub src/trae-product.ts). Do not "tidy" them.
 */
export interface TraeProduct {
  id: 'trae' | 'trae-intl'
  site: 'cn' | 'global'
  displayName: string
  /** SOLO chat + model list host. */
  agentHost: string
  /** check-in / credits host. */
  ugHost: string
  /** ExchangeToken host. */
  oauthHost: string
  consoleHost: string
  clientId: string
  appId: string
  ideVersion: string
  ideVersionCode: string
  deviceBrand: string
  osVersion: string
  /** SOLO `function` (channel) default. */
  function: string
  /** channel priority used when the same model appears in several channels. */
  channels: readonly string[]
  userAgent: string
  fallbackModels: ReadonlyArray<{ id: string; name: string }>
}

export const TRAE_CHANNELS: readonly string[] = [
  'solo_work_lite',
  'solo_agent_remote',
  'solo_agent',
  'solo_work',
]

export const TRAE_FALLBACK_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
]

export const TRAE: TraeProduct = {
  id: 'trae',
  site: 'cn',
  displayName: 'TRAE (字节)',
  agentHost: 'https://trae-api-cn.mchost.guru',
  ugHost: 'https://api.trae.cn',
  oauthHost: 'https://api.trae.com.cn',
  consoleHost: 'https://www.trae.cn',
  clientId: 'en1oxy7wnw8j9n',
  appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  ideVersion: '0.1.52',
  ideVersionCode: '20260811',
  deviceBrand: 'Apple',
  osVersion: 'macOS 15.7.4',
  function: 'solo_work_lite',
  channels: TRAE_CHANNELS,
  userAgent: 'Trae/0.1.52',
  fallbackModels: TRAE_FALLBACK_MODELS,
}

/**
 * TRAE international.
 *
 * Login state is NOT shared with CN (different client_id / portal), so it is a
 * separate provider with its own credential. Identity fields reuse the CN values
 * because the global SOLO channel has not been independently verified; inventing
 * new ones would be guessing.
 */
export const TRAE_INTL: TraeProduct = {
  id: 'trae-intl',
  site: 'global',
  displayName: 'TRAE (国际版)',
  agentHost: 'https://api5-normal-alisg.mchost.guru',
  ugHost: 'https://api.trae.ai',
  oauthHost: 'https://api.trae.ai',
  consoleHost: 'https://www.trae.ai',
  clientId: 'en1oxy7wnw8j9n',
  appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  ideVersion: '0.1.52',
  ideVersionCode: '20260811',
  deviceBrand: 'Apple',
  osVersion: 'macOS 15.7.4',
  function: 'solo_work_lite',
  channels: TRAE_CHANNELS,
  userAgent: 'Trae/0.1.52',
  fallbackModels: TRAE_FALLBACK_MODELS,
}

export const ALL_TRAE_PRODUCTS: readonly TraeProduct[] = [TRAE, TRAE_INTL]

export function traeProductById(id: string): TraeProduct | undefined {
  return ALL_TRAE_PRODUCTS.find((p) => p.id === id)
}

// -- endpoint paths ---------------------------------------------------------
export const TRAE_CHAT_PATH = '/api/agent/v3/llm_utils_chat'
export const TRAE_BATCH_MODELS_PATH = '/api/ide/v1/batch_get_detail_param'
export const TRAE_EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'
export const TRAE_USER_INFO_PATH = '/cloudide/api/v3/trae/GetUserInfo'
export const TRAE_CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
export const TRAE_CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'
export const TRAE_ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage'

export const TRAE_REQUEST_TIMEOUT_MS = 30_000
export const TRAE_MAX_OUTPUT_TOKENS = 32_000
/** SOLO `function` name; other values are rejected upstream. */
export const TRAE_FUNCTION = 'solo_work_lite'
export const TRAE_DEFAULT_MODEL = 'glm-5.2'
