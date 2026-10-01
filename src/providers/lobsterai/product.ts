/**
 * LobsterAI (有道龙虾) product configuration.
 *
 * Values are taken verbatim from the verified reference implementation
 * (jet-hub src/lobsterai-product.ts), which reverse-engineered them from the
 * official client. Do not "tidy" them: the User-Agent and client-capabilities
 * string are protocol identity markers.
 *
 * Verified endpoints (reference §4 + client.go):
 * | purpose       | method | path                              | auth   |
 * |---------------|--------|-----------------------------------|--------|
 * | token exchange| POST   | /api/auth/exchange                | none   |
 * | refresh       | POST   | /api/auth/refresh                 | none   |
 * | chat          | POST   | /api/proxy/v1/chat/completions    | Bearer |
 * | models        | GET    | /api/models/available             | Bearer |
 * | balance       | GET    | /api/user/profile-summary         | Bearer |
 */
export interface LobsteraiProduct {
  id: 'lobsterai'
  displayName: string
  portalBase: string
  apiBase: string
  clientVersionApi: string
  fallbackClientVersion: string
  userAgent: string
  clientCapabilities: string
  fallbackModels: ReadonlyArray<{ id: string; name: string; contextWindow?: number }>
}

export const LOBSTERAI_PORTAL_BASE = 'https://lobsterai.youdao.com'
export const LOBSTERAI_API_BASE = 'https://lobsterai-server.youdao.com'
export const LOBSTERAI_CLIENT_VERSION_API =
  'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update'
export const LOBSTERAI_FALLBACK_CLIENT_VERSION = '2026.9.4'
export const LOBSTERAI_USER_AGENT = 'LobsterAI/0.1.0'
/**
 * Both capabilities matter (verified):
 * - `kimi-k3-agentic-v1` gates the model list (without it `kimi-k3` is missing);
 * - `thinking-level-control-v1` is required before `reasoning_effort: "off"` is
 *   accepted (otherwise the upstream returns HTTP 500).
 */
export const LOBSTERAI_CLIENT_CAPABILITIES = 'kimi-k3-agentic-v1,thinking-level-control-v1'

/** Fallback catalog used only when the remote list cannot be fetched. */
export const LOBSTERAI_FALLBACK_MODELS: ReadonlyArray<{ id: string; name: string; contextWindow?: number }> = [
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_000_000 },
  { id: 'glm-5', name: 'GLM-5', contextWindow: 131_072 },
]

export const LOBSTERAI: LobsteraiProduct = {
  id: 'lobsterai',
  displayName: 'LobsterAI (有道)',
  portalBase: LOBSTERAI_PORTAL_BASE,
  apiBase: LOBSTERAI_API_BASE,
  clientVersionApi: LOBSTERAI_CLIENT_VERSION_API,
  fallbackClientVersion: LOBSTERAI_FALLBACK_CLIENT_VERSION,
  userAgent: LOBSTERAI_USER_AGENT,
  clientCapabilities: LOBSTERAI_CLIENT_CAPABILITIES,
  fallbackModels: LOBSTERAI_FALLBACK_MODELS,
}
