/**
 * At-rest credential encryption (AES-256-GCM).
 *
 * Provider tokens are NEVER stored in plaintext. The key is derived from
 * `GATEWAY_SECRET`. Used by every storage backend (memory + SQLite).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

export class CredentialCipher {
  private readonly key: Buffer

  constructor(secret: string) {
    if (!secret || secret.length < 16) {
      throw new Error('GATEWAY_SECRET must be set and at least 16 characters')
    }
    this.key = createHash('sha256').update(secret).digest()
  }

  encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
    const iv = randomBytes(IV_LEN)
    const cipher = createCipheriv(ALGO, this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return { ciphertext, iv, tag }
  }

  decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer): string {
    const decipher = createDecipheriv(ALGO, this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }

  encryptJson(obj: unknown): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
    return this.encrypt(JSON.stringify(obj))
  }

  decryptJson<T>(blob: { ciphertext: Buffer; iv: Buffer; tag: Buffer }): T {
    return JSON.parse(this.decrypt(blob.ciphertext, blob.iv, blob.tag)) as T
  }
}
