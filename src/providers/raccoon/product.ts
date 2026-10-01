/**
 * Raccoon Work (商汤小浣熊) product configuration.
 * Verified reference: jet-hub src/raccoon-product.ts.
 */
export interface RaccoonProduct {
  id: 'raccoon'
  displayName: string
  apiBase: string
  authApiPrefix: string
  llmApiPrefix: string
  pointsApiPrefix: string
  desktopApiPrefix: string
  userAgent: string
  clientPlatform: string
  clientVersion: string
  fallbackModels: ReadonlyArray<{ id: string; name: string }>
}

export const RACCOON: RaccoonProduct = {
  id: 'raccoon',
  displayName: 'Raccoon (商汤)',
  apiBase: 'https://xiaohuanxiong.com',
  authApiPrefix: '/api/web/auth/v1',
  llmApiPrefix: '/api/web/llm/v2',
  pointsApiPrefix: '/api/web/points/v1',
  desktopApiPrefix: '/api/web/desktop/v1',
  userAgent: 'Raccoon Work/1.0.35 (Windows)',
  clientPlatform: 'desktop-windows',
  clientVersion: 'v1.0.35',
  fallbackModels: [
    { id: 'sn-sensenova-6-8-flash', name: 'SenseNova 6.8 Flash' },
    { id: 'sn-glm-5-3', name: 'GLM-5.3' },
    { id: 'sn-kimi-k3', name: 'Kimi K3' },
    { id: 'sn-deepseek-v4-1-flash', name: 'DeepSeek V4.1 Flash' },
  ],
}

// -- endpoint paths ---------------------------------------------------------
export const RACCOON_QR_LOGIN_PATH = '/login_with_qrcode_code'
export const RACCOON_SEND_SMS_PATH = '/send_sms'
export const RACCOON_LOGIN_SMS_PATH = '/login_with_sms'
export const RACCOON_REFRESH_PATH = '/refresh'
export const RACCOON_USER_INFO_PATH = '/user_info'
export const RACCOON_MODEL_CATALOG_PATH = '/model_catalog'
export const RACCOON_CHAT_PATH = '/chat/completions'
export const RACCOON_BALANCE_PATH = '/balance'
export const RACCOON_BILLS_PATH = '/bills'
export const RACCOON_LOGIN_GRANT_PATH = '/desktop/v1/login/points/grant'

export const RACCOON_QR_POLL_INTERVAL_MS = 2_000
export const RACCOON_LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** access tokens live ~3h; refresh 5 minutes early */
export const RACCOON_TOKEN_REFRESH_WINDOW_SECONDS = 300
