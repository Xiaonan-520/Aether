/**
 * Gateway API-key lifecycle: create, list, revoke and verify.
 *
 * Security invariants enforced here (and only here):
 * - The complete key is returned by `create()` and afterwards never again.
 * - `keyHash` never appears in any returned record or audit event.
 * - Audit events record *that* something happened, never key material.
 */
import { randomBytes } from 'node:crypto'
import type { ServiceContext } from './context.js'
import type { ApiKeyRecord } from '../store/types.js'
import { OpenAIApiError } from '../protocol/openai/parse.js'
import {
  apiKeyPrefixOf,
  generateApiKey,
  hashApiKey,
  hashEquals,
} from '../core/apikeys/hash.js'

/** Public (safe) projection of a stored key — never contains hash or key. */
export interface ApiKeyView {
  id: string
  name: string
  keyPrefix: string
  enabled: boolean
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

export interface CreatedApiKey extends ApiKeyView {
  /** The one-and-only time the full key is returned. */
  key: string
}

function toView(record: ApiKeyRecord): ApiKeyView {
  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    enabled: record.enabled,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  }
}

export class ApiKeyService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Issue a new key. Returns the full key exactly once. */
  create(input: { name?: unknown; expiresAt?: unknown }): CreatedApiKey {
    const name = typeof input.name === 'string' && input.name.trim().length > 0
      ? input.name.trim().slice(0, 120)
      : 'unnamed'
    let expiresAt: number | null = null
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      const value = Number(input.expiresAt)
      if (!Number.isFinite(value) || value <= 0) {
        throw new OpenAIApiError(400, 'invalid_request_error', 'expiresAt must be a positive epoch-millisecond number')
      }
      expiresAt = Math.floor(value)
    }

    const { key, prefix, hash } = generateApiKey()
    const now = this.ctx.now()
    const record: ApiKeyRecord = {
      id: `apikey-${randomBytes(4).toString('hex')}`,
      name,
      keyPrefix: prefix,
      keyHash: hash,
      enabled: true,
      createdAt: now,
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
    }
    const result = this.ctx.store.createApiKey(record)
    if (!result.ok) {
      throw new OpenAIApiError(409, 'invalid_request_error', result.error)
    }
    this.audit('apikey.created', `api key ${record.id} ("${name}") created`, record.id)
    return { ...toView(record), key }
  }

  /** Redacted listing — no key, no hash. */
  list(): ApiKeyView[] {
    return this.ctx.store.listApiKeys().map(toView)
  }

  /** Soft-revoke (and disable) a key by id. */
  remove(id: string): { ok: true } {
    const existing = this.ctx.store.listApiKeys().find((k) => k.id === id)
    if (!existing) {
      throw new OpenAIApiError(404, 'invalid_request_error', `api key "${id}" not found`)
    }
    const result = this.ctx.store.revokeApiKey(id, this.ctx.now())
    if (!result.ok) {
      throw new OpenAIApiError(404, 'invalid_request_error', result.error)
    }
    this.audit('apikey.revoked', `api key ${id} revoked`, id)
    return { ok: true }
  }

  /**
   * Verify a presented bearer key against the issued-key table.
   * Returns true only for an enabled, unrevoked, unexpired key with a matching
   * hash. Touches `last_used_at` on success and writes an audit event — neither
   * record contains key material.
   */
  verify(presented: string): boolean {
    const prefix = apiKeyPrefixOf(presented)
    if (!prefix) return false

    const record = this.ctx.store.getApiKeyByPrefix(prefix)
    if (!record) return false
    if (!record.enabled || record.revokedAt !== null) return false
    if (record.expiresAt !== null && record.expiresAt <= this.ctx.now()) return false
    if (!hashEquals(hashApiKey(presented), record.keyHash)) return false

    const now = this.ctx.now()
    this.ctx.store.touchApiKey(record.id, now)
    this.audit('apikey.used', `api key ${record.id} authenticated a request`, record.id)
    return true
  }

  /** Events carry ids and counts only — never a key or a hash. */
  private audit(kind: string, message: string, id: string): void {
    this.ctx.store.addEvent({
      ts: this.ctx.now(),
      level: 'info',
      kind,
      message,
      payload_json: JSON.stringify({ apiKeyId: id }),
    })
  }
}
