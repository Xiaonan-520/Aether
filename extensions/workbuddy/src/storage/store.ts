/**
 * Extension-owned persistence. A dedicated SQLite database that belongs entirely
 * to this Extension — it is independent of any Gateway Core database/filesystem.
 *
 * Credentials are stored encrypted (AES-256-GCM) and are never part of any
 * protocol response. Login sessions (the opaque upstream state) are stored
 * separately so an interrupted login can resume after a restart, until TTL.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { AccountStatus } from '../protocol/types.js'
import { decrypt, deriveKey, encrypt, randomHex } from '../util/crypto.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,               -- opaque accountId (Core-allocated or wbcn-<rand>)
  provider_id     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  enabled         INTEGER NOT NULL DEFAULT 1,
  display_name    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  auth_state      TEXT,                           -- opaque upstream login state (not a secret)
  auth_url        TEXT,
  auth_started_at INTEGER,                        -- ms; drives login TTL
  last_error      TEXT,
  last_success_at TEXT,
  last_failure_at TEXT
);
CREATE TABLE IF NOT EXISTS credentials (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enc         TEXT NOT NULL                       -- AES-256-GCM ciphertext
);
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_cache (
  id         TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quota_cache (
  account_id TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
`

/** A decrypted account credential held in memory for the duration of use. */
export interface Credential {
  access_token: string
  refresh_token: string
  expires_at: string
  refresh_expires_at: string
  token_type: string
  scope: string
  domain: string
  user_id: string
  nickname: string
  enterprise_id: string
  account_type: string
}

export interface AccountRow {
  id: string
  provider_id: string
  status: AccountStatus
  enabled: boolean
  display_name?: string
  created_at: string
  updated_at: string
  auth_state?: string
  auth_url?: string
  auth_started_at?: number
  last_error?: string
  last_success_at?: string
  last_failure_at?: string
}

export class Store {
  private readonly db: Database.Database
  private readonly key: Buffer

  constructor(dataDir: string, encryptionKey?: string) {
    mkdirSync(dataDir, { recursive: true })
    const keyFile = join(dataDir, 'encryption.key')
    this.key = encryptionKey ? deriveKey(encryptionKey) : deriveKey(this.loadOrCreateKey(keyFile))
    this.db = new Database(join(dataDir, 'extension.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  private loadOrCreateKey(keyFile: string): string {
    try {
      const existing = readFileSync(keyFile, 'utf8').trim()
      if (existing.length > 0) return existing
    } catch {
      // create below
    }
    const secret = randomHex(32)
    writeFileSync(keyFile, secret, { encoding: 'utf8', mode: 0o600 })
    return secret
  }

  close(): void {
    this.db.close()
  }

  // ── kv ────────────────────────────────────────────────
  kvGet(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  // ── accounts ──────────────────────────────────────────
  listAccounts(): AccountRow[] {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all() as Array<Record<string, unknown>>
    return rows.map(mapAccountRow)
  }

  getAccount(id: string): AccountRow | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? mapAccountRow(row) : undefined
  }

  accountExists(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id))
  }

  /** Create a pending login account (or reset an existing not-logged-in one). */
  createPendingAccount(row: {
    id: string
    provider_id: string
    display_name?: string
    auth_state?: string
    auth_url?: string
    auth_started_at?: number
  }): void {
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO accounts (id, provider_id, status, enabled, display_name, created_at, updated_at, auth_state, auth_url, auth_started_at)
       VALUES (@id, @provider_id, 'pending', 1, @display_name, @now, @now, @auth_state, @auth_url, @auth_started_at)
       ON CONFLICT(id) DO UPDATE SET
         status = 'pending',
         display_name = COALESCE(excluded.display_name, accounts.display_name),
         updated_at = excluded.updated_at,
         auth_state = excluded.auth_state,
         auth_url = excluded.auth_url,
         auth_started_at = excluded.auth_started_at,
         last_error = NULL`,
    ).run({
      id: row.id,
      provider_id: row.provider_id,
      display_name: row.display_name ?? null,
      now,
      auth_state: row.auth_state ?? null,
      auth_url: row.auth_url ?? null,
      auth_started_at: row.auth_started_at ?? Date.now(),
    })
  }

  setAccountStatus(id: string, status: AccountStatus, lastError?: string): void {
    const now = new Date().toISOString()
    this.db.prepare(
      `UPDATE accounts SET status = ?, updated_at = ?, last_error = COALESCE(?, last_error),
         last_success_at = CASE WHEN ? = 'active' THEN ? ELSE last_success_at END,
         last_failure_at = CASE WHEN ? IN ('auth_failed','token_expired','error') THEN ? ELSE last_failure_at END
       WHERE id = ?`,
    ).run(status, now, lastError ?? null, status, now, status, now, id)
  }

  setAccountEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE accounts SET enabled = ?, updated_at = ? WHERE id = ?').run(
      enabled ? 1 : 0,
      new Date().toISOString(),
      id,
    )
  }

  setAccountLoginMeta(id: string, authState?: string, authUrl?: string): void {
    this.db.prepare('UPDATE accounts SET auth_state = ?, auth_url = ?, updated_at = ? WHERE id = ?').run(
      authState ?? null,
      authUrl ?? null,
      new Date().toISOString(),
      id,
    )
  }

  setDisplayName(id: string, displayName: string): void {
    this.db.prepare('UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?').run(
      displayName,
      new Date().toISOString(),
      id,
    )
  }

  /** Remove a credential but keep the account row (used on terminal-auth failure). */
  clearCredential(accountId: string): void {
    this.db.prepare('DELETE FROM credentials WHERE account_id = ?').run(accountId)
  }

  deleteAccount(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM credentials WHERE account_id = ?').run(id)
    this.db.prepare('DELETE FROM quota_cache WHERE account_id = ?').run(id)
  }

  // ── credentials (encrypted) ───────────────────────────
  saveCredential(accountId: string, credential: Credential): void {
    const enc = encrypt(JSON.stringify(credential), this.key)
    this.db.prepare(
      'INSERT INTO credentials (account_id, enc) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET enc = excluded.enc',
    ).run(accountId, enc)
  }

  getCredential(accountId: string): Credential | undefined {
    const row = this.db.prepare('SELECT enc FROM credentials WHERE account_id = ?').get(accountId) as
      | { enc: string }
      | undefined
    if (!row) return undefined
    try {
      return JSON.parse(decrypt(row.enc, this.key)) as Credential
    } catch {
      return undefined
    }
  }

  // ── model cache ───────────────────────────────────────
  getModelCache(): { payload: string; fetchedAt: number } | undefined {
    return (this.db.prepare('SELECT payload, fetched_at AS fetchedAt FROM model_cache WHERE id = ?').get('default') as
      | { payload: string; fetchedAt: number }
      | undefined) ?? undefined
  }

  putModelCache(payload: string): void {
    this.db.prepare(
      `INSERT INTO model_cache (id, payload, fetched_at) VALUES ('default', ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
    ).run(payload, Date.now())
  }

  // ── quota cache ───────────────────────────────────────
  getQuotaCache(accountId: string): { payload: string; fetchedAt: number } | undefined {
    return (this.db.prepare('SELECT payload, fetched_at AS fetchedAt FROM quota_cache WHERE account_id = ?').get(
      accountId,
    ) as { payload: string; fetchedAt: number } | undefined) ?? undefined
  }

  putQuotaCache(accountId: string, payload: string): void {
    this.db.prepare(
      `INSERT INTO quota_cache (account_id, payload, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
    ).run(accountId, payload, Date.now())
  }
}

function mapAccountRow(row: Record<string, unknown>): AccountRow {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return {
    id: String(row.id),
    provider_id: String(row.provider_id),
    status: row.status as AccountStatus,
    enabled: Boolean(row.enabled),
    display_name: str(row.display_name),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    auth_state: str(row.auth_state),
    auth_url: str(row.auth_url),
    auth_started_at: typeof row.auth_started_at === 'number' ? row.auth_started_at : undefined,
    last_error: str(row.last_error),
    last_success_at: str(row.last_success_at),
    last_failure_at: str(row.last_failure_at),
  }
}
