/**
 * Storage abstraction.
 *
 * Gateway Core / Service / Scheduler depend only on this interface — never on
 * SQLite or on the in-memory implementation. Two backends are provided:
 * - MemoryStore  (tests, mock-upstream E2E, no-SQLite fallback)
 * - SQLiteStore  (Docker runtime, gated behind better-sqlite3)
 *
 * Credential values are ALWAYS encrypted via CredentialCipher before they reach
 * the backend; a store only ever sees ciphertext for credentials.
 */
import type {
  Account,
  AccountPatch,
  ModelEntry,
  QuotaSnapshot,
  ClaimOutcome,
} from '../core/types.js'

export interface CredentialBlob {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

export interface StoredAccount {
  account: Account
  credential: CredentialBlob | null
}

export type StoreResult = { ok: true } | { ok: false; error: string }

export interface Job {
  id: string
  provider: string | null
  accountId: string | null
  jobType: string
  scheduledAt: number
  startedAt: number | null
  finishedAt: number | null
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  error: string | null
  resultJson: string | null
  attempts: number
}

export interface StoreGateway {
  /** Account CRUD. `credential` is attached where present. */
  listAccounts(provider?: string): StoredAccount[]
  getAccount(id: string): StoredAccount | undefined
  createAccount(account: Account): StoreResult
  patchAccount(id: string, patch: AccountPatch): StoreResult
  removeAccount(id: string): StoreResult

  /** Credential (encrypted) storage, keyed by credentialKey. */
  setCredential(key: string, blob: CredentialBlob): void
  getCredential(key: string): CredentialBlob | null
  deleteCredential(key: string): void

  /** Model registry entries. */
  upsertModels(entries: ModelEntry[]): void
  listModels(): ModelEntry[]

  /** Quota snapshots per account. */
  setQuota(accountId: string, snapshot: QuotaSnapshot): void
  getQuota(accountId: string): QuotaSnapshot | null

  /** Credit claim history (idempotency). */
  recordClaim(accountId: string, provider: string, type: string, at: number, outcome: ClaimOutcome): void
  isClaimedToday(accountId: string, type: string, dateKey: string): boolean

  /** Background job queue. */
  createJob(job: Job): void
  updateJob(id: string, patch: Partial<Job>): void
  listJobs(jobType?: string): Job[]
  nextDueJobs(jobType: string, now: number): Job[]

  /** Audit events. */
  addEvent(event: Record<string, unknown>): void
  listEvents(limit: number): Record<string, unknown>[]

  /** Global settings (gateway api key hash, timezone, etc). */
  getSetting(key: string): unknown
  setSetting(key: string, value: unknown): void
}
