/**
 * Model listing: merges the models table with live provider catalogs and
 * annotates availability (does the provider have at least one usable account).
 * Credentials and account details never appear in the output.
 */
import type { ModelEntry } from '../core/types.js'
import { OpenAIApiError } from '../protocol/openai/parse.js'
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
    const seen = new Map<string, PublicModel>()
    for (const entry of this.ctx.store.listModels()) {
      if (!entry.enabled) continue
      const hasAccount = this.providerHasUsableAccount(entry.provider)
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

  private providerHasUsableAccount(provider: string): boolean {
    return this.ctx.store
      .listAccounts(provider)
      .some((s) => s.account.enabled && s.account.status === 'active')
  }
}
