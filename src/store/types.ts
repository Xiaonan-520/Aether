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

/**
 * A gateway API key as persisted. `keyHash` is the SHA-256 of the full key;
 * the plaintext key is never stored and never leaves the service layer.
 */
export interface ApiKeyRecord {
  id: string
  name: string
  /** Short, non-secret discriminator (first 8 chars of the key body). */
  keyPrefix: string
  /** SHA-256(full key), lowercase hex. */
  keyHash: string
  enabled: boolean
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

/** Fields accepted when creating an API key. */
export type ApiKeyInput = Omit<ApiKeyRecord, 'lastUsedAt' | 'revokedAt'>

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

  /** Registered provider adapters (FK target for accounts/models rows). */
  upsertProviders(providers: Array<{ id: string; displayName: string; capabilitiesJson: string; enabled?: boolean }>): void

  /** Model registry entries. */
  upsertModels(entries: ModelEntry[]): void
  listModels(): ModelEntry[]

  /** Quota snapshots per account. */
  setQuota(accountId: string, snapshot: QuotaSnapshot): void
  getQuota(accountId: string): QuotaSnapshot | null

  /** Credit claim history (idempotency). */
  recordClaim(accountId: string, provider: string, type: string, at: number, outcome: ClaimOutcome): void
  isClaimedToday(accountId: string, type: string, dateKey: string): boolean
  /** Most recent recorded outcome for (account, type, day); null when none. */
  lastClaimOutcome(accountId: string, type: string, dateKey: string): ClaimOutcome | null

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

  /** Issued gateway API keys (hash-only storage). */
  createApiKey(record: ApiKeyRecord): StoreResult
  listApiKeys(): ApiKeyRecord[]
  /** Locate one candidate row by its non-secret prefix. */
  getApiKeyByPrefix(prefix: string): ApiKeyRecord | undefined
  /** Record that a key was used now (audit; no key material involved). */
  touchApiKey(id: string, at: number): void
  /** Soft-delete: stamps revoked_at and disables the key. */
  revokeApiKey(id: string, at: number): StoreResult
}
