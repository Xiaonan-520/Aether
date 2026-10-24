/**
 * Admin password hashing.
 *
 * Uses Node's built-in scrypt — no native dependency, and the algorithm is
 * memory-hard unlike a bare SHA-256. The encoded string carries everything
 * needed to verify later (algorithm, cost parameters, salt, digest) so that
 * parameters can be raised in a future release without invalidating old rows.
 *
 * Format: scrypt$N$r$p$<salt-b64url>$<hash-b64url>
 *
 * A password is NEVER logged, stored in plaintext, or encrypted reversibly.
 * Only this one-way digest is persisted.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/** Minimum admin password length, enforced at the service boundary. */
export const MIN_PASSWORD_LENGTH = 10

/** Hard cap: rejects absurd inputs that would make scrypt expensive. */
export const MAX_PASSWORD_LENGTH = 1024

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64
const SALT_LEN = 16
// scrypt needs roughly 128 * N * r bytes; 64 MiB default is plenty here.
const MAX_MEM = 64 * 1024 * 1024

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: n, r, p, maxmem: MAX_MEM }, (err, key) => {
      if (err) reject(err)
      else resolve(key as Buffer)
    })
  })
}

/**
 * Hash a password for storage. Returns the self-describing encoded string.
 * Throws on out-of-range lengths so callers fail closed rather than storing
 * an unusable digest.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`password must be at most ${MAX_PASSWORD_LENGTH} characters`)
  }
  const salt = randomBytes(SALT_LEN)
  const digest = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    digest.toString('base64url'),
  ].join('$')
}

/**
 * Verify a password against an encoded digest.
 *
 * Always returns false for a malformed/unsupported record instead of throwing,
 * so a corrupted row cannot turn into a 500 that reveals its existence.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  // Reject parameters above what this build will compute — an attacker who can
  // write a row must not be able to demand unbounded work.
  if (n > 1 << 20 || r > 32 || p > 16) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], 'base64url')
    expected = Buffer.from(parts[5], 'base64url')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let actual: Buffer
  try {
    actual = await scryptAsync(password, salt, n, r, p)
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
