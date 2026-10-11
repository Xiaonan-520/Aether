/**
 * Manager installation store (RFC §"Storage": minimal installation metadata).
 *
 * Own SQLite database file — the manager never touches Core's gateway.db
 * (RFC §25.2: no cross-container SQLite sharing). Reuses the project's
 * better-sqlite3 dependency; schema is versioned and droppable.
 *
 * Stored: extension identity, image/digest pin, container handle, lifecycle
 * status, manifest hash, timestamps. NEVER: provider credentials, OAuth
 * tokens, the extension token plaintext (only a SHA-256 fingerprint for
 * rotation audits).
 */

import Database from 'better-sqlite3'

export type ExtensionStatus =
  | 'pending' | 'validating' | 'pulling' | 'starting' | 'health_check'
  | 'conformance' | 'registering' | 'installed' | 'failed' | 'removing'

export interface InstallRecord {
  extensionId: string
  version: string
  imageRepo: string
  imageTag: string
  imageDigest: string | null
  containerId: string | null
  endpointUrl: string | null
  status: ExtensionStatus
  /** sha256 of the canonical manifest JSON */
  manifestHash: string
  /** sha256 fingerprint of the injected extension token (never the token) */
  tokenFingerprint: string
  error: string | null
  installedAt: number
  updatedAt: number
}

export class ManagerStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS extensions (
        extension_id     TEXT PRIMARY KEY,
        version          TEXT NOT NULL,
        image_repo       TEXT NOT NULL,
        image_tag        TEXT NOT NULL,
        image_digest     TEXT,
        container_id     TEXT,
        endpoint_url     TEXT,
        status           TEXT NOT NULL,
        manifest_hash    TEXT NOT NULL,
        token_fingerprint TEXT NOT NULL,
        error            TEXT,
        installed_at     INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS registration_tokens (
        extension_id TEXT PRIMARY KEY,
        ciphertext   BLOB NOT NULL,
        iv           BLOB NOT NULL,
        tag          BLOB NOT NULL
      );
    `)
    const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1)
  }

  /** Rollback helper: drops manager-owned tables only. */
  dropAll(): void {
    this.db.exec('DROP TABLE IF EXISTS registration_tokens; DROP TABLE IF EXISTS extensions; DROP TABLE IF EXISTS schema_version;')
  }

  putRegistrationToken(extensionId: string, blob: { ciphertext: Buffer; iv: Buffer; tag: Buffer }): void {
    this.db.prepare(`
      INSERT INTO registration_tokens (extension_id, ciphertext, iv, tag)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(extension_id) DO UPDATE SET
        ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag
    `).run(extensionId, blob.ciphertext, blob.iv, blob.tag)
  }

  getRegistrationToken(extensionId: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } | undefined {
    const row = this.db.prepare('SELECT * FROM registration_tokens WHERE extension_id = ?').get(extensionId) as
      | { ciphertext: Buffer; iv: Buffer; tag: Buffer }
      | undefined
    return row
  }

  deleteRegistrationToken(extensionId: string): void {
    this.db.prepare('DELETE FROM registration_tokens WHERE extension_id = ?').run(extensionId)
  }

  upsert(rec: InstallRecord): void {
    this.db.prepare(`
      INSERT INTO extensions (
        extension_id, version, image_repo, image_tag, image_digest, container_id,
        endpoint_url, status, manifest_hash, token_fingerprint, error, installed_at, updated_at
      ) VALUES (
        @extensionId, @version, @imageRepo, @imageTag, @imageDigest, @containerId,
        @endpointUrl, @status, @manifestHash, @tokenFingerprint, @error, @installedAt, @updatedAt
      )
      ON CONFLICT(extension_id) DO UPDATE SET
        version=excluded.version, image_repo=excluded.image_repo, image_tag=excluded.image_tag,
        image_digest=excluded.image_digest, container_id=excluded.container_id,
        endpoint_url=excluded.endpoint_url, status=excluded.status,
        manifest_hash=excluded.manifest_hash, token_fingerprint=excluded.token_fingerprint,
        error=excluded.error, updated_at=excluded.updated_at
    `).run(rec)
  }

  setStatus(extensionId: string, status: ExtensionStatus, error?: string): void {
    this.db.prepare('UPDATE extensions SET status = ?, error = ?, updated_at = ? WHERE extension_id = ?')
      .run(status, error ?? null, Date.now(), extensionId)
  }

  get(extensionId: string): InstallRecord | undefined {
    const row = this.db.prepare('SELECT * FROM extensions WHERE extension_id = ?').get(extensionId) as Record<string, unknown> | undefined
    return row ? rowToRecord(row) : undefined
  }

  list(): InstallRecord[] {
    const rows = this.db.prepare('SELECT * FROM extensions ORDER BY extension_id').all() as Array<Record<string, unknown>>
    return rows.map(rowToRecord)
  }

  delete(extensionId: string): void {
    this.db.prepare('DELETE FROM extensions WHERE extension_id = ?').run(extensionId)
  }

  close(): void {
    this.db.close()
  }
}

/** SQLite snake_case columns → camelCase InstallRecord. */
function rowToRecord(row: Record<string, unknown>): InstallRecord {
  return {
    extensionId: row.extension_id as string,
    version: row.version as string,
    imageRepo: row.image_repo as string,
    imageTag: row.image_tag as string,
    imageDigest: (row.image_digest as string | null) ?? null,
    containerId: (row.container_id as string | null) ?? null,
    endpointUrl: (row.endpoint_url as string | null) ?? null,
    status: row.status as InstallRecord['status'],
    manifestHash: row.manifest_hash as string,
    tokenFingerprint: row.token_fingerprint as string,
    error: (row.error as string | null) ?? null,
    installedAt: row.installed_at as number,
    updatedAt: row.updated_at as number,
  }
}
