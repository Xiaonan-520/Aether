/**
 * Admin session tokens.
 *
 * The browser holds an opaque random token; the database only ever stores its
 * SHA-256. That means a database read cannot be replayed as a live session,
 * and revocation is a single row update.
 *
 * Deliberately NOT a JWT: sessions must be revocable immediately, and an
 * opaque token is the simplest thing that satisfies that.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Prefix distinguishes a session token from a gateway API key (`gw-…`). */
export const SESSION_TOKEN_PREFIX = 'adm'

const TOKEN_BYTES = 32

/** A fresh session token: 32 random bytes, base64url, prefixed for auditability. */
export function generateSessionToken(): string {
  return `${SESSION_TOKEN_PREFIX}-${randomBytes(TOKEN_BYTES).toString('base64url')}`
}

/** SHA-256 of the full token, lowercase hex. This is what gets persisted. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time comparison of two hex digests. */
export function sessionHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** Cheap shape check before touching the store. */
export function looksLikeSessionToken(token: string): boolean {
  return token.startsWith(`${SESSION_TOKEN_PREFIX}-`) && token.length > SESSION_TOKEN_PREFIX.length + 20
}
