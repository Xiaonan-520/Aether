/**
 * Gateway API key material: generation and hashing only.
 *
 * DELIBERATELY separate from `store/crypto.ts`: provider credentials must be
 * *recoverable* (upstream needs the plaintext token), so they are encrypted.
 * An issued gateway API key must NOT be recoverable — a database leak must not
 * reveal a usable key. Therefore keys are one-way hashed, never encrypted.
 *
 * Format: `gw-<prefix8>.<secret32>`
 * - `prefix8`  — 8 chars, stored in clear: a non-secret discriminator that lets
 *                verification find the candidate row without scanning every row.
 * - `secret32` — 32 chars of high-entropy randomness; only its SHA-256 is stored.
 *
 * The full key is returned exactly once (at creation) and is never logged,
 * never persisted, and never returned by any read endpoint.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Fixed public prefix, so keys are recognisable in logs/config (not secret). */
export const API_KEY_PREFIX = 'gw'
/** Length of the clear-text discriminator. */
export const API_KEY_PREFIX_LEN = 8
/** Bytes of randomness behind the secret half (base64url → 43 chars, sliced). */
const SECRET_BYTES = 24

/** URL-safe alphabet without characters that invite transcription mistakes. */
function randomToken(length: number): string {
  let out = ''
  while (out.length < length) {
    out += randomBytes(SECRET_BYTES).toString('base64url').replace(/[-_]/g, '')
  }
  return out.slice(0, length)
}

export interface GeneratedApiKey {
  /** The complete key. Hand this to the caller once, then drop it. */
  key: string
  /** Non-secret discriminator persisted for row lookup. */
  prefix: string
  /** SHA-256(full key), lowercase hex. */
  hash: string
}

/** Generate a fresh API key plus its stored representations. */
export function generateApiKey(): GeneratedApiKey {
  const prefix = randomToken(API_KEY_PREFIX_LEN)
  const secret = randomToken(32)
  const key = `${API_KEY_PREFIX}-${prefix}.${secret}`
  return { key, prefix, hash: hashApiKey(key) }
}

/** SHA-256 of the complete key, lowercase hex. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/**
 * Extract the discriminator from a presented key, or null when the shape is
 * not one we issue. Used to reject junk before touching the database.
 */
export function apiKeyPrefixOf(key: string): string | null {
  const m = /^gw-([A-Za-z0-9]{8})\.[A-Za-z0-9]+$/.exec(key)
  return m ? m[1] : null
}

/** Constant-time comparison of two hex digests of equal length. */
export function hashEquals(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false
  const a = Buffer.from(aHex, 'utf8')
  const b = Buffer.from(bHex, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
