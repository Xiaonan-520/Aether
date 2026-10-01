import type { ModelEntry } from '../types.js'
import type { ProviderRegistry } from '../registry/provider-registry.js'

/**
 * ModelRouter maps an OpenAI model string to a concrete provider + upstream
 * model. Supports same-named models across providers (e.g. `::provider` prefix)
 * and priority-based default selection.
 */
export class ModelRouter {
  constructor(
    private readonly registry: ProviderRegistry,
    private getEntries: () => ModelEntry[],
  ) {}

  /**
   * Resolve a requested model to a concrete provider choice.
   * @param requested e.g. `deepseek-v4-flash` or `codearts::deepseek-v4-flash`
   * @param onlyAvailable if true, providers with no usable accounts are skipped
   */
  resolve(
    requested: string,
    onlyAvailable: boolean,
    providerHasAccount: (provider: string) => boolean,
  ): { entry: ModelEntry; provider: string } | null {
    let providerPrefix: string | null = null
    let modelName = requested
    const sep = requested.indexOf('::')
    if (sep > 0) {
      providerPrefix = requested.slice(0, sep)
      modelName = requested.slice(sep + 2)
    }

    const entries = this.getEntries()
      .filter((e) => e.enabled)
      .filter((e) => e.modelId === modelName || e.upstreamModel === modelName)
    if (providerPrefix) {
      // explicit provider: exact match
      const hit = entries.find((e) => e.provider === providerPrefix)
      if (hit) return entryWithProvider(hit)
      const renamed = entries.find((e) => e.provider === providerPrefix && e.upstreamModel === modelName)
      return renamed ? entryWithProvider(renamed) : null
    }

    // no prefix: prefer enabled providers that have a usable account,
    // then fall back to highest-priority entry across all providers
    if (onlyAvailable) {
      const avail = entries.find((e) => providerHasAccount(e.provider))
      if (avail) return entryWithProvider(avail)
    }
    const best = [...entries].sort((a, b) => b.priority - a.priority)[0]
    return best ? entryWithProvider(best) : null
  }
}

function entryWithProvider(entry: ModelEntry): { entry: ModelEntry; provider: string } {
  return { entry, provider: entry.provider }
}
