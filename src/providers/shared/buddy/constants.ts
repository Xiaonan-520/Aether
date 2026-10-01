/**
 * Tencent Buddy-family protocol constants (endpoint paths + HTTP header
 * names). Copied from the reverse-engineered protocol; values are outbound
 * identity markers and must not be renamed.
 */

export const AUTH_STATE_PATH = '/v2/plugin/auth/state'
export const AUTH_TOKEN_PATH = '/v2/plugin/auth/token'
export const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account'
export const AUTH_REFRESH_PATH = '/v2/plugin/auth/token/refresh'
export const CONFIG_PATH = '/v3/config'
export const CHAT_PATH = '/v2/chat/completions'

/** /v2/plugin/auth/token error code: token not ready yet. */
export const CODE_TOKEN_NOT_READY = 11217
/** /v2/plugin/login/account error code: account not ready yet. */
export const CODE_ACCOUNT_NOT_READY = 12151

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
export const POLL_INTERVAL_MS = 1000

export const HTTP_HEADER_DOMAIN = 'X-Domain'
export const HTTP_HEADER_ENTERPRISE_ID = 'X-Enterprise-Id'
export const HTTP_HEADER_TENANT_ID = 'X-Tenant-Id'
export const HTTP_HEADER_NO_AUTHORIZATION = 'X-No-Authorization'
export const HTTP_HEADER_NO_USER_ID = 'X-No-User-Id'
export const HTTP_HEADER_NO_ENTERPRISE_ID = 'X-No-Enterprise-Id'
export const HTTP_HEADER_NO_DEPARTMENT_INFO = 'X-No-Department-Info'
export const HTTP_HEADER_REFRESH_TOKEN = 'X-Refresh-Token'
export const HTTP_HEADER_AUTH_REFRESH_SOURCE = 'X-Auth-Refresh-Source'
export const HTTP_HEADER_PRODUCT = 'X-Product'
export const HTTP_HEADER_PRODUCT_CODE = 'X-Product-Code'

export const AUTH_REFRESH_SOURCE = 'ide-main'
