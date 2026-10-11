/**
 * Console aggregation service: assembles the data the management console
 * renders, from the same store/registry the rest of Core reads. Read-only —
 * it never exposes credential material and never talks to provider upstreams.
 */
import type { ServiceContext } from './context.js'
import { OpenAIApiError } from '../protocol/openai/parse.js'
import { dayKey } from '../store/memory-store.js'

/** The provider's quota snapshot as stored on the account (rawJson preserved). */
export interface QuotaResource {
  accountId: string
  accountDisplayName: string
  known: boolean
  remaining: number | null
  total: number | null
  resetAt: number | null
  lastUpdatedAt: number | null
  raw: unknown | null
}

export interface ConsoleProviderView {
  id: string
  displayName: string
  capabilities: Record<string, unknown>
  accounts: {
    total: number
    enabled: number
    authenticated: number
    available: number
    needsAttention: number
  }
  models: { total: number; enabled: number }
  quotas: QuotaResource[]
  claim: {
    /** true only when at least one account has a real recorded claim outcome */
    hasHistory: boolean
    lastAttemptAt: number | null
    lastOutcome: Record<string, unknown> | null
  }
  lastQuotaAt: number | null
}

export interface ConsoleOverview {
  generatedAt: number
  totals: {
    providers: number
    accounts: number
    accountsAvailable: number
    models: number
    claimsToday: { success: number; failed: number }
  }
  providers: ConsoleProviderView[]
}

/** Account statuses the router can currently pick for a request. */
const USABLE_STATUSES = new Set(['active', 'healthy_low_quota'])

/** Statuses that imply a human or the scheduler must intervene. */
const ATTENTION_STATUSES = new Set([
  'needs_manual_action',
  'token_expired',
  'auth_failed',
  'quota_exhausted',
  'disabled',
])

export class ConsoleService {
  constructor(private readonly ctx: ServiceContext) {}

  getOverview(): ConsoleOverview {
    const now = this.ctx.now()
    const providers = this.ctx.registry.list().map((p) => this.getProvider(p.id))
    const accounts = providers.reduce((n, p) => n + p.accounts.total, 0)
    const accountsAvailable = providers.reduce((n, p) => n + p.accounts.available, 0)
    const models = providers.reduce((n, p) => n + p.models.total, 0)
    return {
      generatedAt: now,
      totals: {
        providers: providers.length,
        accounts,
        accountsAvailable,
        models,
        claimsToday: this.claimsToday(),
      },
      providers,
    }
  }

  getProvider(id: string): ConsoleProviderView {
    const adapter = this.ctx.registry.get(id)
    if (!adapter) {
      throw new OpenAIApiError(404, 'invalid_request_error', `unknown provider "${id}"`)
    }
    const stored = this.ctx.store.listAccounts(id)
    const accounts = stored.map((s) => s.account)
    const models = this.ctx.store.listModels().filter((m) => m.provider === id)

    const quotas: QuotaResource[] = accounts.map((a) => {
      let parsed: { known?: boolean; remaining?: number | null; total?: number | null; resetAt?: number | null } | null = null
      if (a.quotaJson) {
        try {
          parsed = JSON.parse(a.quotaJson)
        } catch {
          parsed = null
        }
      }
      return {
        accountId: a.id,
        accountDisplayName: a.displayName,
        known: parsed?.known ?? false,
        remaining: parsed?.remaining ?? null,
        total: parsed?.total ?? null,
        resetAt: parsed?.resetAt ?? null,
        lastUpdatedAt: a.lastQuotaAt,
        raw: parsed ?? null,
      }
    })

    // Latest recorded claim outcome across the provider's accounts. The store
    // keys claims by (account, type, day); look back over recent day keys.
    let lastAttemptAt: number | null = null
    let lastOutcome: Record<string, unknown> | null = null
    for (const a of accounts) {
      for (let daysAgo = 0; daysAgo < 3; daysAgo++) {
        const at = this.ctx.now() - daysAgo * 86_400_000
        const key = dayKey(at)
        const outcome = this.ctx.store.lastClaimOutcome(a.id, 'credit_claim', key)
        if (outcome === null) continue
        if (lastAttemptAt === null || at > lastAttemptAt) {
          lastAttemptAt = at
          lastOutcome = outcome as unknown as Record<string, unknown>
        }
        break
      }
    }

    return {
      id,
      displayName: adapter.displayName,
      capabilities: adapter.capabilities as unknown as Record<string, unknown>,
      accounts: {
        total: accounts.length,
        enabled: accounts.filter((a) => a.enabled).length,
        authenticated: accounts.filter((a) => a.authenticated).length,
        available: accounts.filter(
          (a) => a.enabled && a.authenticated && USABLE_STATUSES.has(a.status),
        ).length,
        needsAttention: accounts.filter((a) => ATTENTION_STATUSES.has(a.status)).length,
      },
      models: {
        total: models.length,
        enabled: models.filter((m) => m.enabled).length,
      },
      quotas,
      claim: {
        hasHistory: lastOutcome !== null,
        lastAttemptAt,
        lastOutcome,
      },
      lastQuotaAt: accounts.reduce<number | null>(
        (acc, a) => (a.lastQuotaAt !== null && (acc === null || a.lastQuotaAt > acc) ? a.lastQuotaAt : acc),
        null,
      ),
    }
  }

  listProviderModels(id: string): Array<Record<string, unknown>> {
    this.requireProvider(id)
    const openAiModelIds = new Set(
      this.ctx.store
        .listModels()
        .filter((m) => m.enabled)
        .map((m) => m.modelId),
    )
    return this.ctx.store
      .listModels()
      .filter((m) => m.provider === id)
      .map((m) => ({
        modelId: m.modelId,
        upstreamModel: m.upstreamModel,
        name: m.name,
        capabilities: m.capabilities,
        enabled: m.enabled,
        priority: m.priority,
        /** the exact id an OpenAI client sees on /v1/models (when enabled) */
        exposedOnV1: openAiModelIds.has(m.modelId),
      }))
  }

  listProviderQuotas(id: string): QuotaResource[] {
    return this.getProvider(id).quotas
  }

  listProviderClaims(id: string, limit = 50): Array<Record<string, unknown>> {
    this.requireProvider(id)
    const jobs = this.ctx.store
      .listJobs('credit_claim')
      .filter((j) => j.provider === id)
      .slice(-limit)
      .reverse()
    return jobs as unknown as Array<Record<string, unknown>>
  }

  private claimsToday(): { success: number; failed: number } {
    const events = this.ctx.store.listEvents(200)
    let success = 0
    let failed = 0
    for (const e of events) {
      const kind = typeof e.kind === 'string' ? e.kind : ''
      if (!kind.startsWith('claim.')) continue
      const ts = typeof e.ts === 'number' ? e.ts : 0
      if (ts < startOfDay(this.ctx.now())) continue
      if (kind === 'claim.success') success++
      else failed++
    }
    return { success, failed }
  }

  private requireProvider(id: string): void {
    if (!this.ctx.registry.get(id)) {
      throw new OpenAIApiError(404, 'invalid_request_error', `unknown provider "${id}"`)
    }
  }
}

function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
