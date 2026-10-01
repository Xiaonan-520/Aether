/**
 * Provider registration (Phase 3B).
 *
 * Registers the real adapters onto the Phase 3A registry. The four Buddy-family
 * products (WorkBuddy intl/mainland, CodeBuddy mainland/international) share one
 * protocol implementation and differ only by product config; ZCode owns the
 * captcha manager, which is admin-submitted only (never auto-solved).
 */
import type { ProviderRegistry } from '../core/registry/provider-registry.js'
import { createCodeBuddyProvider } from './codebuddy/index.js'
import { createWorkBuddyProvider } from './workbuddy/index.js'
import { createWorkBuddyCnProvider } from './workbuddy-cn/index.js'
import { createBuddyIntlProvider } from './buddy-intl/index.js'
import { createLobsteraiProvider } from './lobsterai/index.js'
import { createClineProvider } from './cline/index.js'
import { createTraeProvider } from './trae/index.js'
import { TRAE, TRAE_INTL } from './trae/product.js'
import { createCodeArtsProvider } from './codearts/index.js'
import { createLoomyProvider } from './loomy/index.js'
import { createQoderProvider } from './qoder/index.js'
import { QODER, QODER_CN } from './qoder/product.js'
import { createRaccoonProvider } from './raccoon/index.js'
import { createZCodeProvider } from './zcode/index.js'
import { ZCodeCaptchaManager } from './zcode/captcha.js'

export interface RegisteredProviders {
  captcha: ZCodeCaptchaManager
}

export interface RegisterOptions {
  fetcher?: typeof fetch
  captcha?: ZCodeCaptchaManager
}

/** Register every built-in adapter. Idempotent per registry instance. */
export function registerProviders(
  registry: ProviderRegistry,
  options: RegisterOptions = {},
): RegisteredProviders {
  const captcha = options.captcha ?? new ZCodeCaptchaManager(options.fetcher ? { fetcher: options.fetcher } : {})
  registry.register(createWorkBuddyProvider(options.fetcher))
  registry.register(createWorkBuddyCnProvider(options.fetcher))
  registry.register(createCodeBuddyProvider(options.fetcher))
  registry.register(createBuddyIntlProvider(options.fetcher))
  registry.register(createLobsteraiProvider(options.fetcher ? { fetcher: options.fetcher } : {}))
  registry.register(createClineProvider(options.fetcher ? { fetcher: options.fetcher } : {}))
  registry.register(createZCodeProvider({ captcha, ...(options.fetcher ? { fetcher: options.fetcher } : {}) }))
  registry.register(createTraeProvider({ product: TRAE, ...(options.fetcher ? { fetcher: options.fetcher } : {}) }))
  registry.register(createTraeProvider({ product: TRAE_INTL, ...(options.fetcher ? { fetcher: options.fetcher } : {}) }))
  registry.register(createCodeArtsProvider(options.fetcher ? { fetcher: options.fetcher } : {}))
  registry.register(createLoomyProvider(options.fetcher ? { fetcher: options.fetcher } : {}))
  registry.register(createQoderProvider({ product: QODER, ...(options.fetcher ? { fetcher: options.fetcher } : {}) }))
  registry.register(createQoderProvider({ product: QODER_CN, ...(options.fetcher ? { fetcher: options.fetcher } : {}) }))
  registry.register(createRaccoonProvider(options.fetcher ? { fetcher: options.fetcher } : {}))
  return { captcha }
}
