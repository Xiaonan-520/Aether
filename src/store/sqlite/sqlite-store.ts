/**
 * SQLite-backed StoreGateway (better-sqlite3, WAL).
 *
 * Loaded dynamically: if the native driver is missing the factory returns
 * undefined and the bootstrap falls back to MemoryStore with a warning.
 * All mapped rows round-trip through the camelCase domain types; JSON columns
 * are parsed/serialized at this boundary only.
 */
import type BetterSqlite3 from 'better-sqlite3'
import type {
  Account,
  AccountPatch,
  ClaimOutcome,
  ModelEntry,
  QuotaSnapshot,
} from '../../core/types.js'
import type {
  CredentialBlob,
  Job,
  StoredAccount,
  StoreGateway,
  StoreResult,
  ApiKeyRecord,
  AdminUserRecord,
  AdminSessionRecord,
} from '../types.js'
import { MIGRATIONS } from './schema.js'
import { dayKey } from '../memory-store.js'

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

export interface SqliteStoreOptions {
  /** 0600 by default; the db holds ciphertext credentials. */
  readonly?: boolean
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

interface AccountRow {
  id: string
  provider: string
  display_name: string | null
  status: string
  enabled: number
  authenticated: number
  token_expiry_at: number | null
  refreshable: number
  credential_key: string
  failure_count: number
  last_success_at: number | null
  last_failure_at: number | null
  last_error: string | null
  cooldown_until: number | null
  model_rate_limits_json: string | null
  quota_json: string | null
  last_quota_at: number | null
  last_credit_claim_at: number | null
  quota_manual_required: number
  provider_metadata_json: string | null
  created_at: number
  updated_at: number
}

function rowToAccount(r: AccountRow): Account {
  return {
    id: r.id,
    provider: r.provider,
    displayName: r.display_name ?? r.id,
    status: r.status as Account['status'],
    enabled: r.enabled !== 0,
    authenticated: r.authenticated !== 0,
    tokenExpiryAt: r.token_expiry_at,
    refreshable: r.refreshable !== 0,
    credentialKey: r.credential_key,
    failureCount: r.failure_count,
    lastSuccessAt: r.last_success_at,
    lastFailureAt: r.last_failure_at,
    lastError: r.last_error,
    cooldownUntil: r.cooldown_until,
    modelRateLimits: parseJson(r.model_rate_limits_json, {}),
    quotaJson: r.quota_json,
    lastQuotaAt: r.last_quota_at,
    lastCreditClaimAt: r.last_credit_claim_at,
    quotaManualRequired: r.quota_manual_required !== 0,
    providerMetadataJson: r.provider_metadata_json,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

interface ModelRow {
  model_id: string
  provider: string
  upstream_model: string
  name: string
  capabilities_json: string | null
  enabled: number
  priority: number
  metadata_json: string | null
}

function rowToModel(r: ModelRow): ModelEntry {
  return {
    modelId: r.model_id,
    provider: r.provider,
    upstreamModel: r.upstream_model,
    name: r.name,
    capabilities: parseJson(r.capabilities_json, {
      vision: false,
      toolCall: false,
      streaming: true,
    }),
    enabled: r.enabled !== 0,
    priority: r.priority,
    metadataJson: r.metadata_json,
  }
}

interface JobRow {
  id: string
  provider: string | null
  account_id: string | null
  job_type: string
  scheduled_at: number
  started_at: number | null
  finished_at: number | null
  status: string
  error: string | null
  result_json: string | null
  attempts: number
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    provider: r.provider,
    accountId: r.account_id,
    jobType: r.job_type,
    scheduledAt: r.scheduled_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status as Job['status'],
    error: r.error,
    resultJson: r.result_json,
    attempts: r.attempts,
  }
}

interface QuotaRow {
  account_id: string
  known: number
  remaining: number | null
  total: number | null
  reset_at: number | null
  last_updated_at: number
  raw_json: string | null
}

function rowToQuota(r: QuotaRow): QuotaSnapshot {
  return {
    known: r.known !== 0,
    remaining: r.remaining,
    total: r.total,
    resetAt: r.reset_at,
    lastUpdatedAt: r.last_updated_at,
    rawJson: r.raw_json,
  }
}

interface ApiKeyRow {
  id: string
  name: string
  key_prefix: string
  key_hash: string
  enabled: number
  created_at: number
  last_used_at: number | null
  expires_at: number | null
  revoked_at: number | null
  /** Present from schema v4; undefined for rows read on an older database. */
  created_by?: string | null
}

function rowToApiKey(r: ApiKeyRow): ApiKeyRecord {
  return {
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    keyHash: r.key_hash,
    enabled: r.enabled !== 0,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    createdBy: r.created_by ?? null,
  }
}

interface AdminUserRow {
  id: string
  email: string
  password_hash: string
  created_at: number
  updated_at: number
}

function rowToAdminUser(r: AdminUserRow): AdminUserRecord {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

interface AdminSessionRow {
  id: string
  user_id: string
  token_hash: string
  created_at: number
  expires_at: number
  last_used_at: number | null
  revoked_at: number | null
}

function rowToAdminSession(r: AdminSessionRow): AdminSessionRecord {
  return {
    id: r.id,
    userId: r.user_id,
    tokenHash: r.token_hash,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }
}

export class SqliteStore implements StoreGateway {
  private readonly db: BetterSqlite3.Database

  constructor(db: BetterSqlite3.Database) {
    this.db = db
    this.migrate()
  }

  /** Runs pending migrations sequentially; safe to call repeatedly. */
  private migrate(): void {
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`,
    )
    const current = (this.db
      .prepare('SELECT MAX(version) AS v FROM schema_version')
      .get() as { v: number | null }).v ?? 0
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue
      const apply = this.db.transaction(() => {
        for (const statement of migration.statements) this.db.exec(statement)
        this.db
          .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
          .run(migration.version, Date.now())
      })
      apply()
    }
  }

  // -- providers ------------------------------------------------------------
  /** Registered provider adapters; FK target for accounts/models rows. */
  upsertProviders(providers: Array<{ id: string; displayName: string; capabilitiesJson: string; enabled?: boolean }>): void {
    const stmt = this.db
      .prepare(
        `INSERT INTO providers (id, display_name, capabilities_json, enabled)
         VALUES (@id, @displayName, @capabilitiesJson, @enabled)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           capabilities_json = excluded.capabilities_json,
           enabled = excluded.enabled`,
      )
    const insertAll = this.db.transaction((rows: Array<{ id: string; displayName: string; capabilitiesJson: string; enabled?: boolean }>) => {
      for (const p of rows) {
        stmt.run({
          id: p.id,
          displayName: p.displayName,
          capabilitiesJson: p.capabilitiesJson,
          enabled: p.enabled === false ? 0 : 1,
        })
      }
    })
    insertAll(providers)
  }

  listProviders(): Array<{ id: string; displayName: string; capabilitiesJson: string; enabled: boolean }> {
    type Row = { id: string; display_name: string; capabilities_json: string; enabled: number }
    const rows = this.db.prepare('SELECT * FROM providers ORDER BY id').all() as Row[]
    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      capabilitiesJson: r.capabilities_json,
      enabled: r.enabled !== 0,
    }))
  }

  // -- accounts -------------------------------------------------------------
  private accountWithCredential(row: AccountRow): StoredAccount {
    const credRow = this.db
      .prepare('SELECT ciphertext, iv, tag FROM credentials WHERE credential_key = ?')
      .get(row.credential_key) as
      | { ciphertext: Buffer; iv: Buffer; tag: Buffer }
      | undefined
    return {
      account: rowToAccount(row),
      credential: credRow ?? null,
    }
  }

  listAccounts(provider?: string): StoredAccount[] {
    const rows = (
      provider === undefined
        ? this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all()
        : this.db.prepare('SELECT * FROM accounts WHERE provider = ? ORDER BY created_at').all(provider)
    ) as AccountRow[]
    return rows.map((r) => this.accountWithCredential(r))
  }

  getAccount(id: string): StoredAccount | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | AccountRow
      | undefined
    return row ? this.accountWithCredential(row) : undefined
  }

  createAccount(account: Account): StoreResult {
    const exists = this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(account.id)
    if (exists) return { ok: false, error: `account "${account.id}" already exists` }
    this.db
      .prepare(
        `INSERT INTO accounts (
           id, provider, display_name, status, enabled, authenticated,
           token_expiry_at, refreshable, credential_key, failure_count,
           last_success_at, last_failure_at, last_error, cooldown_until,
           model_rate_limits_json, quota_json, last_quota_at,
           last_credit_claim_at, quota_manual_required, provider_metadata_json,
           created_at, updated_at
         ) VALUES (
           @id, @provider, @displayName, @status, @enabled, @authenticated,
           @tokenExpiryAt, @refreshable, @credentialKey, @failureCount,
           @lastSuccessAt, @lastFailureAt, @lastError, @cooldownUntil,
           @modelRateLimitsJson, @quotaJson, @lastQuotaAt,
           @lastCreditClaimAt, @quotaManualRequired, @providerMetadataJson,
           @createdAt, @updatedAt
         )`,
      )
      .run({
        id: account.id,
        provider: account.provider,
        displayName: account.displayName,
        status: account.status,
        enabled: account.enabled ? 1 : 0,
        authenticated: account.authenticated ? 1 : 0,
        tokenExpiryAt: account.tokenExpiryAt,
        refreshable: account.refreshable ? 1 : 0,
        credentialKey: account.credentialKey,
        failureCount: account.failureCount,
        lastSuccessAt: account.lastSuccessAt,
        lastFailureAt: account.lastFailureAt,
        lastError: account.lastError,
        cooldownUntil: account.cooldownUntil,
        modelRateLimitsJson: JSON.stringify(account.modelRateLimits ?? {}),
        quotaJson: account.quotaJson,
        lastQuotaAt: account.lastQuotaAt,
        lastCreditClaimAt: account.lastCreditClaimAt,
        quotaManualRequired: account.quotaManualRequired ? 1 : 0,
        providerMetadataJson: account.providerMetadataJson,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      })
    return { ok: true }
  }

  patchAccount(id: string, patch: AccountPatch): StoreResult {
    const current = this.getAccount(id)
    if (!current) return { ok: false, error: `account "${id}" not found` }
    const merged: Account = {
      ...current.account,
      ...patch,
      modelRateLimits: { ...current.account.modelRateLimits, ...(patch.modelRateLimits ?? {}) },
      updatedAt: Date.now(),
    }
    return this.replaceAccount(merged)
  }

  private replaceAccount(account: Account): StoreResult {
    const info = this.db
      .prepare(
        `UPDATE accounts SET
           display_name = @displayName, status = @status, enabled = @enabled,
           authenticated = @authenticated, token_expiry_at = @tokenExpiryAt,
           refreshable = @refreshable, credential_key = @credentialKey,
           failure_count = @failureCount, last_success_at = @lastSuccessAt,
           last_failure_at = @lastFailureAt, last_error = @lastError,
           cooldown_until = @cooldownUntil,
           model_rate_limits_json = @modelRateLimitsJson, quota_json = @quotaJson,
           last_quota_at = @lastQuotaAt, last_credit_claim_at = @lastCreditClaimAt,
           quota_manual_required = @quotaManualRequired,
           provider_metadata_json = @providerMetadataJson, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id: account.id,
        displayName: account.displayName,
        status: account.status,
        enabled: account.enabled ? 1 : 0,
        authenticated: account.authenticated ? 1 : 0,
        tokenExpiryAt: account.tokenExpiryAt,
        refreshable: account.refreshable ? 1 : 0,
        credentialKey: account.credentialKey,
        failureCount: account.failureCount,
        lastSuccessAt: account.lastSuccessAt,
        lastFailureAt: account.lastFailureAt,
        lastError: account.lastError,
        cooldownUntil: account.cooldownUntil,
        modelRateLimitsJson: JSON.stringify(account.modelRateLimits ?? {}),
        quotaJson: account.quotaJson,
        lastQuotaAt: account.lastQuotaAt,
        lastCreditClaimAt: account.lastCreditClaimAt,
        quotaManualRequired: account.quotaManualRequired ? 1 : 0,
        providerMetadataJson: account.providerMetadataJson,
        updatedAt: account.updatedAt,
      })
    return info.changes > 0 ? { ok: true } : { ok: false, error: `account "${account.id}" not found` }
  }

  removeAccount(id: string): StoreResult {
    const info = this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM quotas WHERE account_id = ?').run(id)
    return info.changes > 0 ? { ok: true } : { ok: false, error: `account "${id}" not found` }
  }

  // -- credentials ----------------------------------------------------------
  setCredential(key: string, blob: CredentialBlob): void {
    this.db
      .prepare(
        `INSERT INTO credentials (credential_key, ciphertext, iv, tag, updated_at)
         VALUES (@key, @ciphertext, @iv, @tag, @updatedAt)
         ON CONFLICT(credential_key) DO UPDATE SET
           ciphertext = excluded.ciphertext, iv = excluded.iv,
           tag = excluded.tag, updated_at = excluded.updated_at`,
      )
      .run({
        key,
        ciphertext: blob.ciphertext,
        iv: blob.iv,
        tag: blob.tag,
        updatedAt: Date.now(),
      })
  }

  getCredential(key: string): CredentialBlob | null {
    const row = this.db
      .prepare('SELECT ciphertext, iv, tag FROM credentials WHERE credential_key = ?')
      .get(key) as { ciphertext: Buffer; iv: Buffer; tag: Buffer } | undefined
    return row ?? null
  }

  deleteCredential(key: string): void {
    this.db.prepare('DELETE FROM credentials WHERE credential_key = ?').run(key)
  }

  // -- models ---------------------------------------------------------------
  upsertModels(entries: ModelEntry[]): void {
    const stmt = this.db
      .prepare(
        `INSERT INTO models (
           model_id, provider, upstream_model, name, capabilities_json,
           enabled, priority, metadata_json
         ) VALUES (
           @modelId, @provider, @upstreamModel, @name, @capabilitiesJson,
           @enabled, @priority, @metadataJson
         )
         ON CONFLICT(model_id, provider) DO UPDATE SET
           upstream_model = excluded.upstream_model, name = excluded.name,
           capabilities_json = excluded.capabilities_json,
           enabled = excluded.enabled, priority = excluded.priority,
           metadata_json = excluded.metadata_json`,
      )
    const insertAll = this.db.transaction((rows: ModelEntry[]) => {
      for (const e of rows) {
        stmt.run({
          modelId: e.modelId,
          provider: e.provider,
          upstreamModel: e.upstreamModel,
          name: e.name,
          capabilitiesJson: JSON.stringify(e.capabilities),
          enabled: e.enabled ? 1 : 0,
          priority: e.priority,
          metadataJson: e.metadataJson,
        })
      }
    })
    insertAll(entries)
  }

  listModels(): ModelEntry[] {
    const rows = this.db.prepare('SELECT * FROM models ORDER BY priority DESC').all() as ModelRow[]
    return rows.map(rowToModel)
  }

  // -- quotas ---------------------------------------------------------------
  setQuota(accountId: string, snapshot: QuotaSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO quotas (
           account_id, known, remaining, total, reset_at, last_updated_at, raw_json
         ) VALUES (
           @accountId, @known, @remaining, @total, @resetAt, @lastUpdatedAt, @rawJson
         )
         ON CONFLICT(account_id) DO UPDATE SET
           known = excluded.known, remaining = excluded.remaining,
           total = excluded.total, reset_at = excluded.reset_at,
           last_updated_at = excluded.last_updated_at, raw_json = excluded.raw_json`,
      )
      .run({
        accountId,
        known: snapshot.known ? 1 : 0,
        remaining: snapshot.remaining,
        total: snapshot.total,
        resetAt: snapshot.resetAt,
        lastUpdatedAt: snapshot.lastUpdatedAt,
        rawJson: snapshot.rawJson,
      })
  }

  getQuota(accountId: string): QuotaSnapshot | null {
    const row = this.db.prepare('SELECT * FROM quotas WHERE account_id = ?').get(accountId) as
      | QuotaRow
      | undefined
    return row ? rowToQuota(row) : null
  }

  // -- credit claims ----------------------------------------------------------
  recordClaim(accountId: string, provider: string, type: string, at: number, outcome: ClaimOutcome): void {
    this.db
      .prepare(
        `INSERT INTO credit_claims (
           account_id, provider, claim_type, claim_date, claimed_at, outcome_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      // same local-timezone day key as the memory store / executors, not UTC:
      // a UTC key lost claims made between 00:00 and 08:00 Beijing time and
      // tripped the UNIQUE constraint on the retry
      .run(accountId, provider, type, dayKey(at), at, JSON.stringify(outcome))
  }

  isClaimedToday(accountId: string, type: string, dateKey: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 FROM credit_claims WHERE account_id = ? AND claim_type = ? AND claim_date = ?',
      )
      .get(accountId, type, dateKey)
    return row !== undefined
  }

  lastClaimOutcome(accountId: string, type: string, dateKey: string): ClaimOutcome | null {
    const row = this.db
      .prepare(
        `SELECT outcome_json FROM credit_claims
         WHERE account_id = ? AND claim_type = ? AND claim_date = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(accountId, type, dateKey) as { outcome_json: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.outcome_json) as ClaimOutcome
    } catch {
      return null
    }
  }

  // -- jobs -------------------------------------------------------------------
  createJob(job: Job): void {
    this.db
      .prepare(
        `INSERT INTO jobs (
           id, provider, account_id, job_type, scheduled_at, started_at,
           finished_at, status, error, result_json, attempts
         ) VALUES (
           @id, @provider, @accountId, @jobType, @scheduledAt, @startedAt,
           @finishedAt, @status, @error, @resultJson, @attempts
         )`,
      )
      .run({
        id: job.id,
        provider: job.provider,
        accountId: job.accountId,
        jobType: job.jobType,
        scheduledAt: job.scheduledAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        status: job.status,
        error: job.error,
        resultJson: job.resultJson,
        attempts: job.attempts,
      })
  }

  updateJob(id: string, patch: Partial<Job>): void {
    const current = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
      | JobRow
      | undefined
    if (!current) return
    const merged = { ...rowToJob(current), ...patch }
    this.db
      .prepare(
        `UPDATE jobs SET
           provider = @provider, account_id = @accountId, job_type = @jobType,
           scheduled_at = @scheduledAt, started_at = @startedAt,
           finished_at = @finishedAt, status = @status, error = @error,
           result_json = @resultJson, attempts = @attempts
         WHERE id = @id`,
      )
      .run({
        id: merged.id,
        provider: merged.provider,
        accountId: merged.accountId,
        jobType: merged.jobType,
        scheduledAt: merged.scheduledAt,
        startedAt: merged.startedAt,
        finishedAt: merged.finishedAt,
        status: merged.status,
        error: merged.error,
        resultJson: merged.resultJson,
        attempts: merged.attempts,
      })
  }

  listJobs(jobType?: string): Job[] {
    const rows = (
      jobType === undefined
        ? this.db.prepare('SELECT * FROM jobs ORDER BY scheduled_at').all()
        : this.db.prepare('SELECT * FROM jobs WHERE job_type = ? ORDER BY scheduled_at').all(jobType)
    ) as JobRow[]
    return rows.map(rowToJob)
  }

  nextDueJobs(jobType: string, now: number): Job[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE job_type = ? AND status = 'pending' AND scheduled_at <= ?
         ORDER BY scheduled_at`,
      )
      .all(jobType, now) as JobRow[]
    return rows.map(rowToJob)
  }

  pruneHistory(beforeMs: number): { jobs: number; events: number } {
    // pending/running jobs are never pruned regardless of age; events have no
    // terminal state, so age is the only criterion
    const jobs = this.db
      .prepare(
        `DELETE FROM jobs
         WHERE status IN ('done', 'failed', 'cancelled')
           AND finished_at IS NOT NULL AND finished_at < ?`,
      )
      .run(beforeMs)
    const events = this.db.prepare('DELETE FROM events WHERE ts < ?').run(beforeMs)
    return { jobs: jobs.changes, events: events.changes }
  }

  // -- events -----------------------------------------------------------------
  addEvent(event: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO events (
           ts, level, provider, account_id, job_id, kind, message, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        (event.ts as number) ?? Date.now(),
        (event.level as string) ?? 'info',
        (event.provider as string) ?? null,
        (event.accountId as string) ?? null,
        (event.jobId as string) ?? null,
        (event.kind as string) ?? 'unknown',
        (event.message as string) ?? null,
        event.payloadJson !== undefined ? JSON.stringify(event.payloadJson) : null,
      )
  }

  listEvents(limit: number): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?')
      .all(limit) as unknown as Record<string, unknown>[]
  }

  // -- settings ---------------------------------------------------------------
  getSetting(key: string): unknown {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined
    return row ? parseJson<unknown>(row.value_json, undefined) : undefined
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(key, JSON.stringify(value))
  }

  // -- issued gateway API keys ------------------------------------------------
  createApiKey(record: ApiKeyRecord): StoreResult {
    try {
      this.db
        .prepare(
          `INSERT INTO api_keys (id, name, key_prefix, key_hash, enabled, created_at, last_used_at, expires_at, revoked_at, created_by)
           VALUES (@id, @name, @keyPrefix, @keyHash, @enabled, @createdAt, @lastUsedAt, @expiresAt, @revokedAt, @createdBy)`,
        )
        .run({
          id: record.id,
          name: record.name,
          keyPrefix: record.keyPrefix,
          keyHash: record.keyHash,
          enabled: record.enabled ? 1 : 0,
          createdAt: record.createdAt,
          lastUsedAt: record.lastUsedAt,
          expiresAt: record.expiresAt,
          revokedAt: record.revokedAt,
          createdBy: record.createdBy,
        })
      return { ok: true }
    } catch (err) {
      // UNIQUE(id) or UNIQUE(key_hash)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  listApiKeys(): ApiKeyRecord[] {
    return (this.db
      .prepare('SELECT * FROM api_keys ORDER BY created_at DESC')
      .all() as unknown as ApiKeyRow[]).map(rowToApiKey)
  }

  getApiKeyByPrefix(prefix: string): ApiKeyRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM api_keys WHERE key_prefix = ? LIMIT 1')
      .get(prefix) as ApiKeyRow | undefined
    return row ? rowToApiKey(row) : undefined
  }

  touchApiKey(id: string, at: number): void {
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(at, id)
  }

  revokeApiKey(id: string, at: number): StoreResult {
    const info = this.db
      .prepare('UPDATE api_keys SET enabled = 0, revoked_at = ? WHERE id = ?')
      .run(at, id)
    return info.changes > 0 ? { ok: true } : { ok: false, error: `api key "${id}" not found` }
  }

  // -- admin identity ---------------------------------------------------------
  createAdminUser(user: AdminUserRecord): StoreResult {
    try {
      this.db
        .prepare(
          `INSERT INTO admin_users (id, email, password_hash, created_at, updated_at)
           VALUES (@id, @email, @passwordHash, @createdAt, @updatedAt)`,
        )
        .run({
          id: user.id,
          email: user.email,
          passwordHash: user.passwordHash,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        })
      return { ok: true }
    } catch (err) {
      // UNIQUE(id) or UNIQUE(email) — the email index is what makes concurrent
      // first-registration safe: exactly one INSERT can win.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Atomic first-admin insert: a single IMMEDIATE transaction holds the write
   * lock across the emptiness check and the insert, so concurrent registrations
   * cannot both observe an empty table. The UNIQUE(email) index is a second
   * line of defence for the same-email case.
   */
  createFirstAdminUser(user: AdminUserRecord): StoreResult {
    const insert = this.db.transaction((): StoreResult => {
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM admin_users').get() as { n: number }).n
      if (count > 0) return { ok: false, error: 'not_first' }
      try {
        this.db
          .prepare(
            `INSERT INTO admin_users (id, email, password_hash, created_at, updated_at)
             VALUES (@id, @email, @passwordHash, @createdAt, @updatedAt)`,
          )
          .run({
            id: user.id,
            email: user.email,
            passwordHash: user.passwordHash,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
    return insert.immediate()
  }

  getAdminUserByEmail(email: string): AdminUserRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM admin_users WHERE email = ? LIMIT 1')
      .get(email) as AdminUserRow | undefined
    return row ? rowToAdminUser(row) : undefined
  }

  getAdminUserById(id: string): AdminUserRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM admin_users WHERE id = ? LIMIT 1')
      .get(id) as AdminUserRow | undefined
    return row ? rowToAdminUser(row) : undefined
  }

  countAdminUsers(): number {
    return (this.db
      .prepare('SELECT COUNT(*) AS n FROM admin_users')
      .get() as { n: number }).n
  }

  updateAdminPassword(id: string, passwordHash: string, at: number): StoreResult {
    const info = this.db
      .prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, at, id)
    return info.changes > 0 ? { ok: true } : { ok: false, error: `admin user "${id}" not found` }
  }

  revokeAdminSessionsForUser(userId: string, at: number): number {
    const info = this.db
      .prepare('UPDATE admin_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(at, userId)
    return info.changes
  }

  // -- admin sessions ---------------------------------------------------------
  createAdminSession(session: AdminSessionRecord): StoreResult {
    try {
      this.db
        .prepare(
          `INSERT INTO admin_sessions (id, user_id, token_hash, created_at, expires_at, last_used_at, revoked_at)
           VALUES (@id, @userId, @tokenHash, @createdAt, @expiresAt, @lastUsedAt, @revokedAt)`,
        )
        .run({
          id: session.id,
          userId: session.userId,
          tokenHash: session.tokenHash,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          lastUsedAt: session.lastUsedAt,
          revokedAt: session.revokedAt,
        })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  getAdminSessionByTokenHash(tokenHash: string): AdminSessionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM admin_sessions WHERE token_hash = ? LIMIT 1')
      .get(tokenHash) as AdminSessionRow | undefined
    return row ? rowToAdminSession(row) : undefined
  }

  touchAdminSession(id: string, at: number): void {
    this.db.prepare('UPDATE admin_sessions SET last_used_at = ? WHERE id = ?').run(at, id)
  }

  revokeAdminSession(id: string, at: number): boolean {
    const info = this.db
      .prepare('UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(at, id)
    return info.changes > 0
  }

  pruneAdminSessions(beforeMs: number): number {
    const info = this.db
      .prepare('DELETE FROM admin_sessions WHERE expires_at < ?')
      .run(beforeMs)
    return info.changes
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Opens a SQLite db via the optional better-sqlite3 dependency.
 * Returns undefined when the driver is unavailable so callers can fall back
 * to MemoryStore (no-SQLite environments).
 */
export async function openSqliteStore(
  dbPath: string,
): Promise<SqliteStore | undefined> {
  let Database: typeof BetterSqlite3
  try {
    const mod = (await import('better-sqlite3')) as unknown as {
      default: typeof BetterSqlite3
    }
    Database = mod.default ?? (mod as unknown as typeof BetterSqlite3)
  } catch {
    return undefined
  }
  const db = new Database(dbPath)
  return new SqliteStore(db)
}
