/**
 * Buddy-family multi-product contracts.
 *
 * The four products (WorkBuddy intl/mainland, CodeBuddy mainland/international)
 * share one adapter; these tests pin the product-config differences and prove
 * each product exposes its own identity end-to-end (registration → models →
 * chat → stream), plus per-product capability wiring.
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_BUDDY_PRODUCTS,
  BUDDY_INTL,
  CODEBUDDY,
  WORKBUDDY,
  WORKBUDDY_CN,
  buddyProductById,
  resolveUserAgent,
} from '../src/providers/shared/buddy/product.js'
import { createBuddyProvider } from '../src/providers/shared/buddy/provider.js'
import { ProviderRegistry } from '../src/core/registry/provider-registry.js'
import { fetcherFor } from './fixtures/buddy-fetcher.js'

describe('buddy products — configuration', () => {
  it('registers four distinct providers with unique ids', () => {
    const ids = ALL_BUDDY_PRODUCTS.map((p) => p.id)
    expect(ids).toEqual(['workbuddy', 'workbuddy-cn', 'codebuddy', 'buddy-intl'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('each product carries its own endpoint / platform / attribution', () => {
    for (const p of ALL_BUDDY_PRODUCTS) {
      expect(p.endpoint).toMatch(/^https:\/\//)
      expect(p.endpoint).not.toMatch(/\/$/)
      expect(p.apiDomain).toBe(new URL(p.endpoint).hostname)
      expect(p.platform).not.toBe('')
      expect(p.attributionName).not.toBe('')
      expect(p.productCode).not.toBe('')
      expect(p.userAgent).toContain(p.attributionName.split(' ')[0])
    }
    // the two regional pairs must not share endpoints or platform
    expect(WORKBUDDY.endpoint).not.toBe(WORKBUDDY_CN.endpoint)
    expect(WORKBUDDY.platform).not.toBe(WORKBUDDY_CN.platform)
    expect(CODEBUDDY.endpoint).not.toBe(BUDDY_INTL.endpoint)
    expect(CODEBUDDY.platform).not.toBe(BUDDY_INTL.platform)
  })

  it('resolves per-model-family User-Agent, falling back to the product UA', () => {
    expect(resolveUserAgent(WORKBUDDY, 'gpt-5.6-sol')).toContain('WorkBuddy AI')
    expect(resolveUserAgent(WORKBUDDY, 'glm-5.3')).toContain('WorkBuddy/5.5.2 WorkBuddy/')
    expect(resolveUserAgent(CODEBUDDY, 'anything')).toBe(CODEBUDDY.userAgent)
  })

  it('buddyProductById resolves known ids and rejects unknown ones', () => {
    expect(buddyProductById('workbuddy-cn')).toBe(WORKBUDDY_CN)
    expect(buddyProductById('nope')).toBeUndefined()
  })
})

describe('buddy products — adapter wiring', () => {
  it('exposes each product identity and shares the protocol capabilities', () => {
    for (const product of ALL_BUDDY_PRODUCTS) {
      const provider = createBuddyProvider(product, fetcherFor([]))
      expect(provider.id).toBe(product.id)
      expect(provider.displayName).toBe(product.displayName)
      expect(provider.capabilities).toMatchObject({
        supportsOAuth: true,
        supportsRefreshToken: true,
        supportsStreaming: true,
        supportsQuota: true,
        supportsCredits: true,
        loginMode: 'external-link',
        protocol: 'openai-chat',
        needsCaptcha: false,
      })
      expect(typeof provider.chat.listModels).toBe('function')
      expect(typeof provider.chat.chat).toBe('function')
      expect(typeof provider.chat.stream).toBe('function')
      expect(typeof provider.ops.refreshAccount).toBe('function')
      expect(typeof provider.ops.claimCredits).toBe('function')
      expect(typeof provider.ops.getQuota).toBe('function')
      expect(typeof provider.ops.healthCheck).toBe('function')
    }
  })

  it('honours per-product capability overrides without touching protocol defaults', () => {
    const provider = createBuddyProvider(
      { ...WORKBUDDY_CN, capabilities: { supportsCredits: false } },
      fetcherFor([]),
    )
    expect(provider.capabilities.supportsCredits).toBe(false)
    expect(provider.capabilities.supportsStreaming).toBe(true)
    expect(provider.capabilities.protocol).toBe('openai-chat')
  })

  it('registers all four products with no id collisions', () => {
    const registry = new ProviderRegistry()
    for (const product of ALL_BUDDY_PRODUCTS) {
      registry.register(createBuddyProvider(product, fetcherFor([])))
    }
    expect(registry.list().map((p) => p.id).sort()).toEqual([
      'buddy-intl',
      'codebuddy',
      'workbuddy',
      'workbuddy-cn',
    ])
  })
})
