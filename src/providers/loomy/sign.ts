/**
 * iFlytek account (CAccount) HMAC-SHA1 signing.
 *
 * A byte-for-byte port of the Loomy client's `sign.js` (via jet-hub
 * src/loomy-sign.ts). Any deviation makes the account endpoints return an auth
 * failure, so this module is pure functions and its string layout is pinned by
 * tests.
 *
 * Signed string (9 segments joined by `\n`):
 *   METHOD\nESCAPED_PATH\nESCAPED_QUERY\nContent-MD5\nContent-Type\nDate\nNonce\n
 *   SignedHeaders\nCanonicalizedHeaders
 *
 * The last two segments are always empty here (we send no `x-*` headers), so the
 * final string ends with two newlines — do not trim it. The auth header prefix
 * is `account` (`account {ak}:{sig}`), never `Bearer`.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'

export interface LoomySignOptions {
  accessKeyId: string
  accessKeySecret: string
  method: string
  path: string
  queryParams?: Record<string, string>
  /** the already-serialized body — must be byte-identical to what is sent */
  body?: string
  contentType?: string
  /** injected for deterministic tests */
  date?: string
  nonce?: string
}

/** `Content-MD5` (base64); an empty body yields an empty string, not its hash. */
export function loomyContentMd5(body: string): string {
  if (body.length === 0) return ''
  return createHash('md5').update(body, 'utf8').digest('base64')
}

/** RFC3986 escaping (encodeURIComponent plus `! ' ( ) *`). */
function escapeRfc3986(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}

/** Build the RFC3986 query string with sorted keys. */
export function loomyCanonicalQuery(params: Record<string, string> = {}): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${escapeRfc3986(key)}=${escapeRfc3986(params[key] ?? '')}`)
    .join('&')
}

/** HTTP `Date` header value (RFC1123 GMT). */
function httpDate(date: Date): string {
  return date.toUTCString()
}

export interface LoomySignedHeaders {
  Date: string
  Authorization: string
  'Content-MD5'?: string
}

/** Compute the signature and the auth headers for an account request. */
export function signLoomyRequest(options: LoomySignOptions): LoomySignedHeaders {
  const now = options.date ? new Date(options.date) : new Date()
  const date = httpDate(now)
  const nonce = options.nonce ?? randomUUID()
  const body = options.body ?? ''
  const contentType = options.contentType ?? 'application/json'
  const contentMd5 = loomyContentMd5(body)
  const query = loomyCanonicalQuery(options.queryParams)
  const path = options.path.startsWith('/') ? options.path : `/${options.path}`

  const stringToSign = [
    options.method.toUpperCase(),
    escapeRfc3986(path),
    query,
    contentMd5,
    contentType,
    date,
    nonce,
    '', // SignedHeaders (empty: we send no x-* headers)
    '', // CanonicalizedHeaders
  ].join('\n')

  const signature = createHmac('sha1', options.accessKeySecret).update(stringToSign, 'utf8').digest('base64')
  return {
    Date: date,
    Authorization: `account ${options.accessKeyId}:${signature}`,
    ...(contentMd5 !== '' ? { 'Content-MD5': contentMd5 } : {}),
  }
}

export { escapeRfc3986 }
