/**
 * Credential encryption (AES-256-GCM) — authenticated encryption for the secret
 * material the Extension persists on behalf of its accounts.
 *
 * The key is derived from an Extension-owned secret (EXTENSION_ENCRYPTION_KEY)
 * or an auto-generated key stored in the Extension's own data directory. It is
 * NEVER exposed to the Gateway Core and never present in API responses/logs.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

export function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** Encrypt plaintext; output is `iv:ciphertext:authTag` (all base64url). */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('base64url')}:${ciphertext.toString('base64url')}:${authTag.toString('base64url')}`
}

/** Decrypt a previously-encrypted string; throws on tamper or wrong key. */
export function decrypt(payload: string, key: Buffer): string {
  const parts = payload.split(':')
  if (parts.length !== 3) throw new Error('invalid encrypted payload')
  const [ivB64, dataB64, tagB64] = parts as [string, string, string]
  const iv = Buffer.from(ivB64, 'base64url')
  const ciphertext = Buffer.from(dataB64, 'base64url')
  const authTag = Buffer.from(tagB64, 'base64url')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** Random hex secret (for auto-generated extension keys). */
export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}