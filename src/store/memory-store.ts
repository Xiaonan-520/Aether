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
  AdminUserRecord,
  AdminSessionRecord,
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
  private readonly adminUsers = new Map<string, AdminUserRecord>()
  private readonly adminSessions = new Map<string, AdminSessionRecord>()

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

  pruneHistory(beforeMs: number): { jobs: number; events: number } {
    const terminal = new Set(['done', 'failed', 'cancelled'])
    let jobs = 0
    for (const [id, job] of this.jobs) {
      if (terminal.has(job.status) && job.finishedAt !== null && job.finishedAt < beforeMs) {
        this.jobs.delete(id)
        jobs++
      }
    }
    const before = this.events.length
    for (let i = this.events.length - 1; i >= 0; i--) {
      if ((this.events[i].ts as number) < beforeMs) this.events.splice(i, 1)
    }
    return { jobs, events: before - this.events.length }
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

  // -- admin identity ---------------------------------------------------------
  createAdminUser(user: AdminUserRecord): StoreResult {
    if (this.adminUsers.has(user.id)) {
      return { ok: false, error: `admin user "${user.id}" already exists` }
    }
    // Mirrors the UNIQUE(email) index: this is what makes concurrent
    // first-registration safe in the in-memory backend too.
    for (const existing of this.adminUsers.values()) {
      if (existing.email === user.email) {
        return { ok: false, error: 'admin user email already exists' }
      }
    }
    this.adminUsers.set(user.id, { ...user })
    return { ok: true }
  }

  /**
   * Atomic first-admin insert. JS is single-threaded, so the emptiness check
   * and the insert below cannot interleave with another request's — that is
   * exactly the guarantee the service needs, because scrypt runs asynchronously
   * between its own count() and this call.
   */
  createFirstAdminUser(user: AdminUserRecord): StoreResult {
    if (this.adminUsers.size > 0) {
      return { ok: false, error: 'not_first' }
    }
    return this.createAdminUser(user)
  }

  getAdminUserByEmail(email: string): AdminUserRecord | undefined {
    for (const record of this.adminUsers.values()) {
      if (record.email === email) return { ...record }
    }
    return undefined
  }

  getAdminUserById(id: string): AdminUserRecord | undefined {
    const record = this.adminUsers.get(id)
    return record ? { ...record } : undefined
  }

  countAdminUsers(): number {
    return this.adminUsers.size
  }

  // -- admin sessions ---------------------------------------------------------
  createAdminSession(session: AdminSessionRecord): StoreResult {
    if (this.adminSessions.has(session.id)) {
      return { ok: false, error: `admin session "${session.id}" already exists` }
    }
    for (const existing of this.adminSessions.values()) {
      if (existing.tokenHash === session.tokenHash) {
        return { ok: false, error: 'admin session token collision' }
      }
    }
    this.adminSessions.set(session.id, { ...session })
    return { ok: true }
  }

  getAdminSessionByTokenHash(tokenHash: string): AdminSessionRecord | undefined {
    for (const record of this.adminSessions.values()) {
      if (record.tokenHash === tokenHash) return { ...record }
    }
    return undefined
  }

  touchAdminSession(id: string, at: number): void {
    const record = this.adminSessions.get(id)
    if (record) this.adminSessions.set(id, { ...record, lastUsedAt: at })
  }

  revokeAdminSession(id: string, at: number): boolean {
    const record = this.adminSessions.get(id)
    if (!record || record.revokedAt !== null) return false
    this.adminSessions.set(id, { ...record, revokedAt: at })
    return true
  }

  pruneAdminSessions(beforeMs: number): number {
    let removed = 0
    for (const [id, record] of this.adminSessions) {
      if (record.expiresAt < beforeMs) {
        this.adminSessions.delete(id)
        removed++
      }
    }
    return removed
  }
}
