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

  /**
   * Replace an already-registered provider in place (extension upgrade rotates
   * the extension token; reload must swap the mounted RemoteProvider without
   * dropping the old one mid-flight). Returns true when a registration was
   * replaced, false when the id was fresh.
   */
  replace(provider: Provider): boolean {
    const existed = this.providers.has(provider.id)
    this.providers.set(provider.id, provider)
    return existed
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
