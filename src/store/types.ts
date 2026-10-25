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
  /**
   * Admin who created the key, or null for keys issued before ownership was
   * tracked / with the static env token. Provenance only — never used for
   * authorization decisions.
   */
  createdBy: string | null
}

/** Fields accepted when creating an API key. */
export type ApiKeyInput = Omit<ApiKeyRecord, 'lastUsedAt' | 'revokedAt'>

/**
 * A human administrator. `passwordHash` is the self-describing scrypt digest
 * from `core/auth/password.ts`; the password itself is never stored.
 */
export interface AdminUserRecord {
  id: string
  /** Normalized (trimmed, lowercased) address; unique. */
  email: string
  /** Encoded scrypt digest: scrypt$N$r$p$salt$hash. */
  passwordHash: string
  createdAt: number
  updatedAt: number
}

/**
 * A login session. `tokenHash` is SHA-256 of the bearer token the browser
 * holds — the token itself is never persisted.
 */
export interface AdminSessionRecord {
  id: string
  userId: string
  tokenHash: string
  createdAt: number
  expiresAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

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
  /** Delete terminal jobs and events older than `beforeMs`; returns rows removed. */
  pruneHistory(beforeMs: number): { jobs: number; events: number }

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

  /**
   * Admin identity (email + scrypt digest). Separate trust domain from
   * api_keys: these are humans, those are machine clients.
   */
  createAdminUser(user: AdminUserRecord): StoreResult
  /**
   * Insert only when no admin exists yet, as ONE atomic operation.
   *
   * This is what makes concurrent first-registration safe: `count()` followed
   * by `create()` is a check-then-act race that lets several simultaneous
   * requests past the check while scrypt hashing runs. Returns
   * `{ ok: false, error: 'not_first' }` when an admin already exists.
   */
  createFirstAdminUser(user: AdminUserRecord): StoreResult
  getAdminUserByEmail(email: string): AdminUserRecord | undefined
  getAdminUserById(id: string): AdminUserRecord | undefined
  /** Number of admin accounts; used to close public registration permanently. */
  countAdminUsers(): number
  /** Replace the password digest for an existing admin. */
  updateAdminPassword(id: string, passwordHash: string, at: number): StoreResult
  /** Revoke every live session of one admin (used after a password change). */
  revokeAdminSessionsForUser(userId: string, at: number): number

  /**
   * Login sessions. Only the SHA-256 of the token is stored, so a database
   * read cannot be replayed as a live session.
   */
  createAdminSession(session: AdminSessionRecord): StoreResult
  getAdminSessionByTokenHash(tokenHash: string): AdminSessionRecord | undefined
  touchAdminSession(id: string, at: number): void
  /** Stamp revoked_at (idempotent); returns false when the row is unknown. */
  revokeAdminSession(id: string, at: number): boolean
  /** Delete sessions that expired before `beforeMs`; returns rows removed. */
  pruneAdminSessions(beforeMs: number): number
}
