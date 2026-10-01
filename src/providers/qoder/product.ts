/**
 * Qoder product configuration (阿里系, international + CN).
 *
 * Qoder INTL and CN share one protocol and one adapter; only the hosts and the
 * `Cosy-ClientType` value differ, so both are expressed as config (same pattern
 * as the Buddy and TRAE families).
 *
 * Verified reference: jet-hub src/qoder-product.ts.
 */
export interface QoderProduct {
  id: 'qoder' | 'qoder-cn'
  displayName: string
  /** browser authorization origin (device select page lives here) */
  authBase: string
  /** openapi host: device poll, refresh and userinfo all live here */
  openApiBase: string
  /** encrypted inference host (must be the api2 family; api2-v2 404s) */
  inferHost: string
  /** `/sash/` endpoints (usage, activities) — holds Cosy-ClientType */
  sashBase: string
  /** user-facing portal */
  portalBase: string
  clientId: string
  /** `Cosy-ClientType` for the `/sash/` endpoints (official desktop = '10'). */
  clientType: number
  /** encrypted-inference request-body client metadata (CLI defaults). */
  clientMetadata: {
    client_type: string
    business_product: string
    business_type: string
    scene: string
  }
  userAgentPrefix: string
  clientVersion: string
  fallbackModels: ReadonlyArray<{ id: string; name: string }>
}

/** Client version travelling in `Cosy-Version` and the signing payload. */
export const QODER_COSY_VERSION = '1.0.0'

export const QODER: QoderProduct = {
  id: 'qoder',
  displayName: 'Qoder',
  authBase: 'https://qoder.com',
  openApiBase: 'https://openapi.qoder.sh',
  inferHost: 'https://api2.qoder.sh',
  sashBase: 'https://api2.qoder.sh',
  portalBase: 'https://qoder.com',
  clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
  clientType: 10,
  clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
  userAgentPrefix: 'qoder',
  clientVersion: QODER_COSY_VERSION,
  fallbackModels: [
    { id: 'qmodel_38max', name: 'Qwen3.8-Max' },
    { id: 'qfmodel', name: 'Qwen3.8-Flash' },
    { id: 'dmodel', name: 'DeepSeek-V4-Pro' },
    { id: 'gmodel', name: 'GLM-5.3' },
  ],
}

export const QODER_CN: QoderProduct = {
  id: 'qoder-cn',
  displayName: 'Qoder (国内版)',
  authBase: 'https://qoder.cn',
  openApiBase: 'https://openapi.qoder.com.cn',
  inferHost: 'https://api2-v2.qoder.sh',
  sashBase: 'https://gateway.qoder.com.cn',
  portalBase: 'https://qoder.cn',
  clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
  clientType: 10,
  clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
  userAgentPrefix: 'qoder',
  clientVersion: QODER_COSY_VERSION,
  fallbackModels: [
    { id: 'qmodel_38max', name: 'Qwen3.8-Max' },
    { id: 'qfmodel', name: 'Qwen3.8-Flash' },
    { id: 'gmodel', name: 'GLM-5.3' },
    { id: 'dmodel', name: 'DeepSeek-V4-Pro' },
  ],
}

export const ALL_QODER_PRODUCTS: readonly QoderProduct[] = [QODER, QODER_CN]

export function qoderProductById(id: string): QoderProduct | undefined {
  return ALL_QODER_PRODUCTS.find((p) => p.id === id)
}

// -- endpoint paths ---------------------------------------------------------
export const QODER_DEVICE_SELECT_PATH = '/device/selectAccounts'
export const QODER_POLL_PATH = '/api/v1/deviceToken/poll'
export const QODER_REFRESH_PATH = '/api/v1/deviceToken/refresh'
export const QODER_USERINFO_PATH = '/api/v1/userinfo'
export const QODER_CHAT_PATH = '/model/v1/chat/completions'
/** encrypted inference path (WASM-built) */
export const QODER_ENCRYPTED_INFER_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation'
/** usage / activities (Bearer + Cosy-ClientType only, no WASM) */
export const QODER_USAGE_PATH = '/sash/api/v2/me/usage'
export const QODER_CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'
