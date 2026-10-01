/**
 * CodeBuddy international provider.
 *
 * Shares the whole CodeBuddy protocol via src/providers/shared/buddy; only the
 * endpoint/platform differ (the regional backend returns its own model pool).
 */
import { createBuddyProvider } from '../shared/buddy/provider.js'
import { BUDDY_INTL } from '../shared/buddy/product.js'
import type { Provider } from '../../core/registry/provider.js'

export const BUDDY_INTL_PRODUCT = BUDDY_INTL

export function createBuddyIntlProvider(fetcher: typeof fetch = fetch): Provider {
  return createBuddyProvider(BUDDY_INTL, fetcher)
}
