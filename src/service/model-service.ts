/**
 * Model listing: merges the models table with live provider catalogs and
 * annotates availability (does the provider have at least one usable account).
 * Credentials and account details never appear in the output.
 */
import type { ModelEntry } from '../core/types.js'
import { OpenAIApiError } from '../protocol/openai/parse.js'
import { AccountPool } from '../core/pool/account-pool.js'
import type { ServiceContext } from './context.js'

export interface PublicModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
  available: boolean
  capabilities: ModelEntry['capabilities']
}

export class ModelService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Models that can actually route right now (enabled + usable account). */
  listAvailable(): PublicModel[] {
    return this.list(true)
  }

  list(onlyAvailable = false): PublicModel[] {
    const entries = this.ctx.store.listModels()
    // Namespaced rows (`provider::model`) supersede legacy bare-id rows for the
    // same upstream model: when a distinct canonical row exists, the bare
    // duplicate is kept for routing compatibility but hidden from the public
    // list so a model is advertised exactly once.
    const canonical = new Set(
      entries
        .filter((e) => e.modelId === `${e.provider}::${e.upstreamModel}`)
        .map((e) => `${e.provider}::${e.upstreamModel}`),
    )
    const seen = new Map<string, PublicModel>()
    for (const entry of entries) {
      if (!entry.enabled) continue
      if (!entry.modelId.includes('::') && canonical.has(`${entry.provider}::${entry.upstreamModel}`)) continue
      // Availability must match the same account-level filter the router uses:
      // a provider with accounts that cannot serve THIS model is not "available"
      // for it.
      const hasAccount = this.providerHasUsableAccount(entry.provider, entry.upstreamModel)
      const id = entry.modelId
      const existing = seen.get(id)
      if (existing && existing.available) continue // a better route already wins
      if (onlyAvailable && !hasAccount) continue
      seen.set(id, {
        id,
        object: 'model',
        created: 0,
        owned_by: entry.provider,
        available: hasAccount,
        capabilities: entry.capabilities,
      })
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /** GET /v1/models response body. */
  toOpenAiList(models: PublicModel[]): Record<string, unknown> {
    return { object: 'list', data: models }
  }

  /** Explicit `provider::model` resolution helper used by the admin API. */
  requireEntry(modelId: string, providerPrefix?: string): ModelEntry {
    const resolution = this.ctx.router.resolve(
      providerPrefix ? `${providerPrefix}::${modelId}` : modelId,
      false,
      () => true,
    )
    if (!resolution) {
      throw new OpenAIApiError(404, 'invalid_request_error', `model "${modelId}" not found`)
    }
    return resolution.entry
  }

  private providerHasUsableAccount(provider: string, model?: string): boolean {
    // same predicate the pool selects with, so a routable account is never
    // hidden from /v1/models (e.g. rate_limited past its cooldown) and an
    // account that declares a different model catalog is not advertised for
    // a model it cannot serve
    const now = this.ctx.now()
    return this.ctx.store
      .listAccounts(provider)
      .some(
        (s) =>
          s.account.enabled &&
          AccountPool.isSelectable(s.account, now) &&
          (model === undefined || AccountPool.supportsModel(s.account, model)),
      )
  }
}
