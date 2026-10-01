/**
 * CodeBuddy provider (Tencent CodeBuddy, mainland).
 *
 * Same protocol as WorkBuddy — only the product config differs.
 */
import { createBuddyProvider } from '../shared/buddy/provider.js'
import { CODEBUDDY } from '../shared/buddy/product.js'
import type { Provider } from '../../core/registry/provider.js'

export function createCodeBuddyProvider(fetcher: typeof fetch = fetch): Provider {
  return createBuddyProvider(CODEBUDDY, fetcher)
}
