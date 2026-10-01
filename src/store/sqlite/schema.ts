/**
 * SQLite schema and sequential migrations.
 *
 * Column names map 1:1 to the camelCase domain types in core/types.ts
 * (snake_case columns). Credentials are stored as ciphertext blobs only —
 * they are encrypted by CredentialCipher before they reach the store.
 */

export interface Migration {
  version: number
  statements: string[]
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL REFERENCES providers(id),
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        enabled INTEGER NOT NULL DEFAULT 1,
        authenticated INTEGER NOT NULL DEFAULT 0,
        token_expiry_at INTEGER,
        refreshable INTEGER NOT NULL DEFAULT 0,
        credential_key TEXT NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_success_at INTEGER,
        last_failure_at INTEGER,
        last_error TEXT,
        cooldown_until INTEGER,
        model_rate_limits_json TEXT NOT NULL DEFAULT '{}',
        quota_json TEXT,
        last_quota_at INTEGER,
        last_credit_claim_at INTEGER,
        quota_manual_required INTEGER NOT NULL DEFAULT 0,
        provider_metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ix_accounts_provider ON accounts(provider)`,
      `CREATE INDEX IF NOT EXISTS ix_accounts_selection ON accounts(provider, enabled, status)`,
      `CREATE TABLE IF NOT EXISTS credentials (
        credential_key TEXT PRIMARY KEY,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS models (
        model_id TEXT NOT NULL,
        provider TEXT NOT NULL REFERENCES providers(id),
        upstream_model TEXT NOT NULL,
        name TEXT NOT NULL,
        capabilities_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        PRIMARY KEY (model_id, provider)
      )`,
      `CREATE TABLE IF NOT EXISTS quotas (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id),
        known INTEGER NOT NULL DEFAULT 0,
        remaining REAL,
        total REAL,
        reset_at INTEGER,
        last_updated_at INTEGER NOT NULL,
        raw_json TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS credit_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        provider TEXT NOT NULL,
        claim_type TEXT NOT NULL,
        claim_date TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        outcome_json TEXT NOT NULL,
        UNIQUE(account_id, claim_type, claim_date)
      )`,
      `CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        provider TEXT,
        account_id TEXT,
        job_type TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        result_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS ix_jobs_due ON jobs(job_type, status, scheduled_at)`,
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        provider TEXT,
        account_id TEXT,
        job_id TEXT,
        kind TEXT NOT NULL,
        message TEXT,
        payload_json TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts)`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      )`,
    ],
  },
  {
    // Gateway API keys issued through POST /api/keys.
    // Only a SHA-256 hash is stored — never the key itself. `key_prefix` is a
    // short, non-secret discriminator used to locate a candidate row before the
    // constant-time hash comparison.
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER,
        revoked_at INTEGER
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ix_api_keys_hash ON api_keys(key_hash)`,
      `CREATE INDEX IF NOT EXISTS ix_api_keys_prefix ON api_keys(key_prefix)`,
    ],
  },
]
