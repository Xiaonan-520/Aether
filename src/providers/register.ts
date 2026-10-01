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
  return { captcha }
}
