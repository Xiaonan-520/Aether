/**
 * Cline product configuration (verified reference: jet-hub cline-product.ts).
 *
 * Login is the WorkOS device-code flow — no local callback port is needed.
 * All values below are protocol identity markers and are copied verbatim.
 */
export interface ClineProduct {
  id: 'cline'
  displayName: string
  apiBase: string
  appBase: string
  workOsBase: string
  workOsClientId: string
  clientHeaders: Readonly<Record<string, string>>
  /** access-token prefix that must NOT be stripped (`Bearer workos:<jwt>`). */
  tokenPrefix: string
  fallbackModels: ReadonlyArray<{ id: string; name: string }>
}

export const CLINE: ClineProduct = {
  id: 'cline',
  displayName: 'Cline',
  apiBase: 'https://api.cline.bot',
  appBase: 'https://app.cline.bot',
  workOsBase: 'https://api.workos.com',
  workOsClientId: 'client_01K3A541FN8TA3EPPHTD2325AR',
  clientHeaders: {
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline',
    'X-IS-MULTIROOT': 'false',
    'X-CLIENT-TYPE': 'cline-sdk',
  },
  tokenPrefix: 'workos:',
  fallbackModels: [
    { id: 'cline-free/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'cline-free/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
  ],
}

// -- endpoint paths (all under apiBase unless noted) -------------------------
/** device authorization (workOsBase) */
export const CLINE_DEVICE_AUTHORIZATION_PATH = '/user_management/authorize/device'
/** device-code token poll (workOsBase) */
export const CLINE_DEVICE_AUTHENTICATE_PATH = '/user_management/authenticate'
/** register the WorkOS token and receive the Cline token */
export const CLINE_REGISTER_PATH = '/api/v1/auth/register'
export const CLINE_REFRESH_PATH = '/api/v1/auth/refresh'
export const CLINE_CHAT_PATH = '/api/v1/chat/completions'
export const CLINE_MODELS_PATH = '/api/v1/models'
/** recommended models — the only authoritative source of the `free` set (no auth) */
export const CLINE_RECOMMENDED_MODELS_PATH = '/api/v1/ai/cline/recommended-models'
export const CLINE_ME_PATH = '/api/v1/users/me'
/** credit balance for a user id */
export const CLINE_BALANCE_PATH_PREFIX = '/api/v1/users/'

export const CLINE_HTTP_TIMEOUT_MS = 30_000
export const CLINE_DEVICE_AUTH_EXPIRES_MS = 300_000
export const CLINE_DEVICE_AUTH_INTERVAL_MS = 5_000
