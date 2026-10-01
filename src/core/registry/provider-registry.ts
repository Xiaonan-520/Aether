import type { Provider } from './provider.js'

/**
 * Registry of installed provider adapters. No if/else chains: lookups are O(1)
 * by provider id. New providers register on startup.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>()

  register(provider: Provider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`provider "${provider.id}" already registered`)
    }
    this.providers.set(provider.id, provider)
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id)
  }

  hasCapability(id: string, field: keyof Provider['capabilities']): boolean {
    const p = this.providers.get(id)
    return p !== undefined && Boolean(p.capabilities[field])
  }

  list(): Provider[] {
    return [...this.providers.values()]
  }
}
