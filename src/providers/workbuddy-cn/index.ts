/**
 * WorkBuddy mainland provider (腾讯 WorkBuddy 国内版).
 *
 * Shares the whole protocol with the other Buddy-family products via
 * src/providers/shared/buddy; only the product config differs.
 */
import { createBuddyProvider } from '../shared/buddy/provider.js'
import { WORKBUDDY_CN } from '../shared/buddy/product.js'
import type { Provider } from '../../core/registry/provider.js'

export const WORKBUDDY_CN_PRODUCT = WORKBUDDY_CN

export function createWorkBuddyCnProvider(fetcher: typeof fetch = fetch): Provider {
  return createBuddyProvider(WORKBUDDY_CN, fetcher)
}
