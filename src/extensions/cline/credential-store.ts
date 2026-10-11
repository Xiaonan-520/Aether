/**
 * Cline Extension credential store (RFC v2 §3.5, §19.3, §10.3).
 *
 * Same trust model as the other extension stores: AES-256-GCM with a
 * scrypt-derived key from the manager-injected GATEWAY_EXTENSION_SECRET;
 * state lives in the extension's own volume. Plaintext never appears in a
 * protocol response.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClineCredential } from '../../providers/cline/protocol.js'

interface StoredRecord {
  accountId: string
  credential: ClineCredential
  displayName: string | null
  enabled: boolean
  updatedAt: number
}

export class ClineCredentialStore {
  private readonly key: Buffer
  private readonly file: string
  private records = new Map<string, StoredRecord>()

  constructor(dataDir: string, secret: string) {
    this.key = scryptSync(secret, 'gw-ext-cline-salt-v1', 32)
    this.file = join(dataDir, 'cline-credentials.json.enc')
    mkdirSync(dataDir, { recursive: true })
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const blob = JSON.parse(readFileSync(this.file, 'utf8')) as { iv: string; tag: string; data: string }
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(blob.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
      const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8')
      for (const rec of JSON.parse(plain) as StoredRecord[]) this.records.set(rec.accountId, rec)
    } catch {
      this.records = new Map()
    }
  }

  private persist(): void {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify([...this.records.values()])), cipher.final()])
    writeFileSync(this.file, JSON.stringify({
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }), { mode: 0o600 })
  }

  put(accountId: string, credential: ClineCredential, displayName: string | null): void {
    const existing = this.records.get(accountId)
    this.records.set(accountId, {
      accountId,
      credential,
      displayName: displayName ?? existing?.displayName ?? null,
      enabled: existing?.enabled ?? true,
      updatedAt: Date.now(),
    })
    this.persist()
  }

  get(accountId: string): ClineCredential | undefined {
    return this.records.get(accountId)?.credential
  }

  displayName(accountId: string): string | null {
    return this.records.get(accountId)?.displayName ?? null
  }

  setEnabled(accountId: string, enabled: boolean): boolean {
    const rec = this.records.get(accountId)
    if (!rec) return false
    rec.enabled = enabled
    rec.updatedAt = Date.now()
    this.persist()
    return true
  }

  isEnabled(accountId: string): boolean {
    return this.records.get(accountId)?.enabled ?? true
  }

  list(): StoredRecord[] {
    return [...this.records.values()]
  }

  has(accountId: string): boolean {
    return this.records.has(accountId)
  }
}

/** Account-id token minting/verification for the manager-issued extension token. */
export function verifyClineExtensionToken(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
