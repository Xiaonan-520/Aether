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
import { createQoderProvider } from './qoder/index.js'
import { QODER, QODER_CN } from './qoder/product.js'
import { createZCodeProvider } from './zcode/index.js'
import { ZCodeCaptchaManager } from './zcode/captcha/index.js'

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
  // lobsterai: migrated to the extension deployable (src/extensions/lobsterai,
  // installed via the Extension Manager). No in-process adapter anymore —
  // Phase 3 dual-track ends here for this provider.
  // cline: migrated to the extension deployable (src/extensions/cline,
  // installed via the Extension Manager) — batch 3 of the provider migration.
  registry.register(createZCodeProvider({ captcha, ...(options.fetcher ? { fetcher: options.fetcher } : {}) }))
  // trae (both product instances): migrated to the extension deployable
  // (src/extensions/trae, one image serving trae/trae-intl via TRAE_PRODUCT)
  // — batch 4 of the provider migration.
  // codearts: migrated to the extension deployable (src/extensions/codearts)
  // — batch 5 of the provider migration.
  // loomy: migrated to the extension deployable (src/extensions/loomy,
  // installed via the Extension Manager) — batch 2 of the provider migration.
  registry.register(createQoderProvider({ product: QODER, ...(options.fetcher ? { fetcher: options.fetcher } : {}) }))
  registry.register(createQoderProvider({ product: QODER_CN, ...(options.fetcher ? { fetcher: options.fetcher } : {}) }))
  // raccoon: migrated to the extension deployable (src/extensions/raccoon,
  // installed via the Extension Manager) — batch 1 of the provider migration.
  return { captcha }
}
