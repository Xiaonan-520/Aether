/**
 * Provider registration (Phase 3B).
 *
 * Registers the real adapters onto the Phase 3A registry. The four Buddy-family
 * products (WorkBuddy intl/mainland, CodeBuddy mainland/international) share one
 * protocol implementation and differ only by product config; ZCode owns the
 * captcha manager, which is admin-submitted only (never auto-solved).
 */
import type { ProviderRegistry } from '../core/registry/provider-registry.js'
import { createQoderProvider } from './qoder/index.js'
import { QODER, QODER_CN } from './qoder/product.js'

export interface RegisteredProviders {
  /** No built-in providers carry shared state any more (zcode migrated to
   *  extensions/zcode). Kept as an empty record for call-site stability. */
  captcha?: undefined
}

export interface RegisterOptions {
  fetcher?: typeof fetch
}

/** Register every built-in adapter. Idempotent per registry instance. */
export function registerProviders(
  registry: ProviderRegistry,
  options: RegisterOptions = {},
): RegisteredProviders {
  void options
  // workbuddy (international) + workbuddy-cn: migrated to the extension
  // deployables (extensions/workbuddy and extensions/workbuddycn, installed
  // via the Extension Manager) — verified against the real workbuddy.ai
  // upstream on 2026-10-16.
  // codebuddy (mainland) + buddy-intl: migrated to the extension deployable
  // (src/extensions/codebuddy, one image serving both products via
  // CODEBUDDY_PRODUCT) — batch 6 of the provider migration. Shared buddy
  // infrastructure stays in src/providers/shared/buddy for the extension
  // builds (workbuddy / workbuddycn / codebuddy extensions all import it).
  // qoder (both product instances) remain built-in: chat requires the
  // proprietary client WASM (compliance red line — never shipped in an
  // image) pending the RFC §24.7 volume-mount design.
  // zcode: migrated to the extension deployable (extensions/zcode, installed
  // via the Extension Manager) — the final batch of the provider migration.
  // Its captcha surface (manual submission + authorization page) now lives in
  // the extension (GET/POST /v1/captcha); Core no longer proxies it.
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
  return {}
}
