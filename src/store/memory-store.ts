/**
 * In-memory StoreGateway implementation.
 *
 * Used for unit tests, mock-upstream E2E runs, and as a fallback when the
 * native SQLite driver is unavailable. Mirrors the semantics of the SQLite
 * backend: last-writer-wins on records, day-key idempotency on credit claims,
 * `pending` + `scheduledAt <= now` on the job queue.
 */
import type {
  Account,
  AccountPatch,
  ClaimOutcome,
  ModelEntry,
  QuotaSnapshot,
} from '../core/types.js'
import type {
  CredentialBlob,
  Job,
  StoredAccount,
  StoreGateway,
  StoreResult,
  ApiKeyRecord,
} from './types.js'

/** Local-timezone day key, e.g. `2026-10-01` (matches SQLite date() output). */
export function dayKey(atMs: number, tzOffsetMinutes = -new Date().getTimezoneOffset()): string {
  const d = new Date(atMs + tzOffsetMinutes * 60_000)
  return d.toISOString().slice(0, 10)
}

export class MemoryStore implements StoreGateway {
  private readonly accounts = new Map<string, Account>()
  private readonly credentials = new Map<string, CredentialBlob>()
  private readonly providers = new Map<string, { id: string; displayName: string; capabilitiesJson: string; enabled: boolean }>()
  private readonly models = new Map<string, ModelEntry>() // key: `${modelId}\u0000${provider}`
  private readonly quotas = new Map<string, QuotaSnapshot>()
  private readonly claims: Array<{
    accountId: string
    provider: string
    type: string
    at: number
    outcome: ClaimOutcome
  }> = []
  private readonly jobs = new Map<string, Job>()
  private readonly events: Record<string, unknown>[] = []
  private readonly settings = new Map<string, unknown>()
  private readonly apiKeys = new Map<string, ApiKeyRecord>()

  listAccounts(provider?: string): StoredAccount[] {
    return [...this.accounts.values()]
      .filter((a) => provider === undefined || a.provider === provider)
      .map((a) => ({
        account: { ...a, modelRateLimits: { ...a.modelRateLimits } },
        credential: this.credentials.get(a.credentialKey) ?? null,
      }))
  }

  getAccount(id: string): StoredAccount | undefined {
    const account = this.accounts.get(id)
    if (!account) return undefined
    return {
      account: { ...account, modelRateLimits: { ...account.modelRateLimits } },
      credential: this.credentials.get(account.credentialKey) ?? null,
    }
  }

  createAccount(account: Account): StoreResult {
    if (this.accounts.has(account.id)) {
      return { ok: false, error: `account "${account.id}" already exists` }
    }
    this.accounts.set(account.id, { ...account, modelRateLimits: { ...account.modelRateLimits } })
    return { ok: true }
  }

  patchAccount(id: string, patch: AccountPatch): StoreResult {
    const current = this.accounts.get(id)
    if (!current) return { ok: false, error: `account "${id}" not found` }
    this.accounts.set(id, { ...current, ...patch, modelRateLimits: { ...current.modelRateLimits, ...(patch.modelRateLimits ?? {}) } })
    return { ok: true }
  }

  removeAccount(id: string): StoreResult {
    const account = this.accounts.get(id)
    if (!account) return { ok: false, error: `account "${id}" not found` }
    this.accounts.delete(id)
    this.quotas.delete(id)
    return { ok: true }
  }

  setCredential(key: string, blob: CredentialBlob): void {
    this.credentials.set(key, { ...blob, ciphertext: Buffer.from(blob.ciphertext), iv: Buffer.from(blob.iv), tag: Buffer.from(blob.tag) })
  }

  getCredential(key: string): CredentialBlob | null {
    const blob = this.credentials.get(key)
    return blob ?? null
  }

  deleteCredential(key: string): void {
    this.credentials.delete(key)
  }

  upsertProviders(providers: Array<{ id: string; displayName: string; capabilitiesJson: string; enabled?: boolean }>): void {
    for (const p of providers) {
      this.providers.set(p.id, {
        id: p.id,
        displayName: p.displayName,
        capabilitiesJson: p.capabilitiesJson,
        enabled: p.enabled !== false,
      })
    }
  }

  upsertModels(entries: ModelEntry[]): void {
    for (const e of entries) {
      this.models.set(`${e.modelId}\u0000${e.provider}`, { ...e })
    }
  }

  listModels(): ModelEntry[] {
    return [...this.models.values()].map((e) => ({ ...e }))
  }

  setQuota(accountId: string, snapshot: QuotaSnapshot): void {
    this.quotas.set(accountId, { ...snapshot })
  }

  getQuota(accountId: string): QuotaSnapshot | null {
    return this.quotas.get(accountId) ?? null
  }

  recordClaim(accountId: string, provider: string, type: string, at: number, outcome: ClaimOutcome): void {
    this.claims.push({ accountId, provider, type, at, outcome })
  }

  isClaimedToday(accountId: string, type: string, dateKey: string): boolean {
    return this.claims.some(
      (c) => c.accountId === accountId && c.type === type && dayKey(c.at) === dateKey,
    )
  }

  lastClaimOutcome(accountId: string, type: string, dateKey: string): ClaimOutcome | null {
    const matches = this.claims.filter(
      (c) => c.accountId === accountId && c.type === type && dayKey(c.at) === dateKey,
    )
    return matches.length > 0 ? matches[matches.length - 1].outcome : null
  }

  createJob(job: Job): void {
    this.jobs.set(job.id, { ...job })
  }

  updateJob(id: string, patch: Partial<Job>): void {
    const current = this.jobs.get(id)
    if (!current) return
    this.jobs.set(id, { ...current, ...patch })
  }

  listJobs(jobType?: string): Job[] {
    return [...this.jobs.values()]
      .filter((j) => jobType === undefined || j.jobType === jobType)
      .map((j) => ({ ...j }))
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
  }

  nextDueJobs(jobType: string, now: number): Job[] {
    return this.listJobs(jobType).filter(
      (j) => j.status === 'pending' && j.scheduledAt <= now,
    )
  }

  addEvent(event: Record<string, unknown>): void {
    this.events.push({ ...event })
  }

  listEvents(limit: number): Record<string, unknown>[] {
    return this.events.slice(-limit).reverse()
  }

  getSetting(key: string): unknown {
    return this.settings.get(key)
  }

  setSetting(key: string, value: unknown): void {
    this.settings.set(key, value)
  }

  // -- issued gateway API keys ------------------------------------------------
  createApiKey(record: ApiKeyRecord): StoreResult {
    if (this.apiKeys.has(record.id)) {
      return { ok: false, error: `api key "${record.id}" already exists` }
    }
    for (const existing of this.apiKeys.values()) {
      if (existing.keyHash === record.keyHash) {
        return { ok: false, error: 'api key hash collision' }
      }
    }
    this.apiKeys.set(record.id, { ...record })
    return { ok: true }
  }

  listApiKeys(): ApiKeyRecord[] {
    return [...this.apiKeys.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((k) => ({ ...k }))
  }

  getApiKeyByPrefix(prefix: string): ApiKeyRecord | undefined {
    for (const record of this.apiKeys.values()) {
      if (record.keyPrefix === prefix) return { ...record }
    }
    return undefined
  }

  touchApiKey(id: string, at: number): void {
    const record = this.apiKeys.get(id)
    if (record) this.apiKeys.set(id, { ...record, lastUsedAt: at })
  }

  revokeApiKey(id: string, at: number): StoreResult {
    const record = this.apiKeys.get(id)
    if (!record) return { ok: false, error: `api key "${id}" not found` }
    this.apiKeys.set(id, { ...record, enabled: false, revokedAt: at })
    return { ok: true }
  }
}
