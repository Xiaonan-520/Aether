/**
 * Buddy-family product configuration (Tencent CodeBuddy / WorkBuddy).
 *
 * Protocol values (productCode / attributionName / platform / endpoint /
 * User-Agent) are outbound identity markers and are copied verbatim from the
 * reverse-engineered IDE/ext-web protocol; do not "tidy" them. The only
 * differences between the two products are the endpoint, platform and the
 * User-Agent, so both providers share one protocol implementation.
 *
 * @see docs/AUDIT_REPORT.md — buddy.ts / buddy-oauth.ts reuse notes.
 */

export interface BuddyProduct {
  /** Gateway provider id. */
  id: 'workbuddy' | 'workbuddy-cn' | 'codebuddy' | 'buddy-intl'
  displayName: string
  /** `platform` query parameter on /v2/plugin/auth/state. */
  platform: string
  /** API base (no trailing slash). */
  endpoint: string
  /** hostname used for the X-Domain header. */
  apiDomain: string
  /** X-Product-Code — protocol value, not the display name. */
  productCode: string
  /** X-Product / X-IDE-Name / X-IDE-Type. */
  attributionName: string
  clientVersion: string
  userAgent: string
  /** per-model-family User-Agent override (first prefix match wins). */
  userAgentByModelFamily: ReadonlyArray<{ match: string; ua: string }>
  /** model ids used when the remote catalog cannot be fetched. */
  fallbackModels: ReadonlyArray<{ id: string; name: string }>
  /**
   * Per-product capability overrides. All Buddy products share the same
   * protocol, so the defaults are the verified WorkBuddy/CodeBuddy set; a
   * product only overrides what is genuinely different for it.
   */
  capabilities?: Partial<{
    supportsQuota: boolean
    supportsCredits: boolean
    supportsVision: boolean
    supportsToolCall: boolean
  }>
}

const WORKBUDDY_UA_INTL = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2'
const WORKBUDDY_UA_CN = 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2'

/** WorkBuddy (international Tencent WorkBuddy AI), platform = workbuddy-ai. */
export const WORKBUDDY: BuddyProduct = {
  id: 'workbuddy',
  displayName: 'WorkBuddy',
  platform: 'workbuddy-ai',
  endpoint: 'https://www.workbuddy.ai',
  apiDomain: 'www.workbuddy.ai',
  productCode: 'workbuddy',
  attributionName: 'WorkBuddy',
  clientVersion: '5.5.2',
  userAgent: WORKBUDDY_UA_INTL,
  userAgentByModelFamily: [
    { match: 'gpt-', ua: WORKBUDDY_UA_INTL },
    { match: 'gemini-', ua: WORKBUDDY_UA_INTL },
    { match: 'claude-', ua: WORKBUDDY_UA_INTL },
    { match: 'glm-', ua: WORKBUDDY_UA_CN },
    { match: 'hy', ua: WORKBUDDY_UA_CN },
    { match: 'kimi-', ua: WORKBUDDY_UA_CN },
    { match: 'minimax-', ua: WORKBUDDY_UA_CN },
  ],
  fallbackModels: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
  ],
}

/** CodeBuddy (mainland Tencent CodeBuddy), platform = ide. */
export const CODEBUDDY: BuddyProduct = {
  id: 'codebuddy',
  displayName: 'CodeBuddy',
  platform: 'ide',
  endpoint: 'https://copilot.tencent.com',
  apiDomain: 'copilot.tencent.com',
  productCode: 'codebuddy',
  attributionName: 'CodeBuddy',
  clientVersion: '1.106.1',
  userAgent: 'CodeBuddyIDE/1.106.1',
  userAgentByModelFamily: [],
  fallbackModels: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
  ],
}

/** Resolve the User-Agent for one model (first prefix match wins). */
export function resolveUserAgent(product: BuddyProduct, model: string): string {
  for (const rule of product.userAgentByModelFamily) {
    if (model.startsWith(rule.match)) return rule.ua
  }
  return product.userAgent
}

/**
 * WorkBuddy mainland (腾讯 WorkBuddy 国内版), platform = workbuddy.
 *
 * Same protocol/endpoint family as the international product; the model pool and
 * attribution differ. Kept as its own provider because the two sides' login
 * state is not interchangeable.
 */
export const WORKBUDDY_CN: BuddyProduct = {
  id: 'workbuddy-cn',
  displayName: 'WorkBuddy (国内版)',
  platform: 'workbuddy',
  endpoint: 'https://www.workbuddy.cn',
  apiDomain: 'www.workbuddy.cn',
  productCode: 'workbuddy',
  attributionName: 'WorkBuddy',
  clientVersion: '5.5.2',
  userAgent: WORKBUDDY_UA_CN,
  userAgentByModelFamily: [
    { match: 'glm-', ua: WORKBUDDY_UA_CN },
    { match: 'hy', ua: WORKBUDDY_UA_CN },
    { match: 'kimi-', ua: WORKBUDDY_UA_CN },
    { match: 'minimax-', ua: WORKBUDDY_UA_CN },
  ],
  fallbackModels: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'hy3', name: 'Hy3' },
  ],
}

/**
 * CodeBuddy international, platform = ide-intl.
 *
 * Shares the CodeBuddy mainland protocol; only the endpoint differs (regional
 * backends return different model pools).
 */
export const BUDDY_INTL: BuddyProduct = {
  id: 'buddy-intl',
  displayName: 'CodeBuddy (国际版)',
  platform: 'ide-intl',
  endpoint: 'https://www.codebuddy.ai',
  apiDomain: 'www.codebuddy.ai',
  productCode: 'codebuddy',
  attributionName: 'CodeBuddy',
  clientVersion: '1.106.1',
  userAgent: 'CodeBuddyIDE/1.106.1',
  userAgentByModelFamily: [
    { match: 'gpt-', ua: 'CodeBuddyIDE/1.106.1' },
    { match: 'claude-', ua: 'CodeBuddyIDE/1.106.1' },
  ],
  fallbackModels: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
  ],
}

/** All Buddy-family products (registry order). */
export const ALL_BUDDY_PRODUCTS: readonly BuddyProduct[] = [
  WORKBUDDY,
  WORKBUDDY_CN,
  CODEBUDDY,
  BUDDY_INTL,
]

/** Look up a product by gateway provider id. */
export function buddyProductById(id: string): BuddyProduct | undefined {
  return ALL_BUDDY_PRODUCTS.find((p) => p.id === id)
}
