/**
 * WorkBuddy provider (Tencent WorkBuddy AI, international).
 *
 * Shares the whole protocol with CodeBuddy via src/providers/shared/buddy.
 */
import { createBuddyProvider } from '../shared/buddy/provider.js'
import { WORKBUDDY } from '../shared/buddy/product.js'
import type { Provider } from '../../core/registry/provider.js'

export const WORKBUDDY_PRODUCT = WORKBUDDY

export function createWorkBuddyProvider(fetcher: typeof fetch = fetch): Provider {
  return createBuddyProvider(WORKBUDDY, fetcher)
}
