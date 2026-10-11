import type { ModelEntry } from '../types.js'
import type { ProviderRegistry } from '../registry/provider-registry.js'

/**
 * A bare model id matched several enabled providers. Never surfaced raw:
 * onError maps this to a 400 listing the namespaced candidates.
 */
export class AmbiguousModelError extends Error {
  readonly candidates: string[]

  constructor(modelName: string, candidates: string[]) {
    super(
      `model "${modelName}" is ambiguous across providers (${candidates.join(', ')}); ` +
        'retry with a namespaced model id like "provider::model"',
    )
    this.name = 'AmbiguousModelError'
    this.candidates = candidates
  }
}

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

    // no prefix: only route when the model maps to exactly one provider.
    // A provider "claims" the bare name when it published that exact id or a
    // canonical `provider::name` row for the same upstream — a provider whose
    // public id differs entirely (e.g. `p2::other` upstream `name`) never
    // claims `name`, so legacy same-upstream duplicates don't create false
    // ambiguity. Rows from one provider count once; a silent priority pick
    // across providers would hide the choice from the client.
    const claimed = entries.filter(
      (e) => e.modelId === modelName || e.modelId === `${e.provider}::${modelName}`,
    )
    const byProvider = new Map<string, ModelEntry[]>()
    for (const e of claimed) {
      const rows = byProvider.get(e.provider)
      if (rows) rows.push(e)
      else byProvider.set(e.provider, [e])
    }
    if (onlyAvailable) {
      for (const provider of [...byProvider.keys()]) {
        if (!providerHasAccount(provider)) byProvider.delete(provider)
      }
    }
    if (byProvider.size > 1) {
      const candidates = [...byProvider.keys()].map((provider) => `${provider}::${modelName}`).sort()
      throw new AmbiguousModelError(modelName, candidates)
    }
    const rows = byProvider.values().next().value
    if (!rows) return null
    const best = [...rows].sort((a, b) => b.priority - a.priority)[0]
    return entryWithProvider(best)
  }
}

function entryWithProvider(entry: ModelEntry): { entry: ModelEntry; provider: string } {
  return { entry, provider: entry.provider }
}
