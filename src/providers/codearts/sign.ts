/**
 * Huawei Cloud SDK-HMAC-SHA256 request signing.
 *
 * Ported from the verified reference (jet-hub src/sign.ts), which mirrors the
 * official SDK spec. The canonical request is:
 *
 *   METHOD\nURI\nQUERY\n<header lines sorted by lowercased name>\n\n<SIGNED_HEADERS>\n<PAYLOAD_HASH>
 *
 * and the string to sign is `SDK-HMAC-SHA256\n<X-Sdk-Date>\n<canonicalHash>`.
 *
 * `known-vector` tests in tests/codearts.spec.ts pin this output so a refactor
 * cannot silently change the signature.
 */
import { createHash, createHmac } from 'node:crypto'

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function hmacSha256Hex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex')
}

/** Build the canonical request string used by Huawei's signer. */
export function buildCanonicalRequest(
  method: string,
  uri: string,
  query: string,
  headers: ReadonlyMap<string, string>,
  payloadHash: string,
): string {
  const signedHeaders = [...headers.keys()].sort()
  const headerLines = signedHeaders.map((k) => `${k}:${headers.get(k) ?? ''}`)
  return [method, uri, query, headerLines.join('\n'), '', signedHeaders.join(';'), payloadHash].join('\n')
}

export interface SignedHuaweiRequest {
  headers: Record<string, string>
  /** the exact canonical request string (useful for tests/diagnostics) */
  canonicalRequest: string
  signature: string
}

/**
 * Sign a Huawei Cloud request.
 *
 * @param ak access key id
 * @param sk secret access key
 * @param securityToken temporary security token (required)
 * @param dateStamp ISO date compacted to `YYYYMMDDTHHMMSSZ`; injectable so the
 *   signature is deterministic in tests.
 */
export function signHuaweiRequest(
  ak: string,
  sk: string,
  securityToken: string,
  method: string,
  urlStr: string,
  body: Uint8Array,
  extraHeaders: Readonly<Record<string, string>> = {},
  dateStamp: string = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'),
): SignedHuaweiRequest {
  const url = new URL(urlStr)
  let uri = url.pathname
  if (!uri.endsWith('/')) uri += '/'
  const query = url.search.slice(1)
  const payloadHash = sha256Hex(body)

  const headers = new Map<string, string>()
  headers.set('host', url.host)
  headers.set('x-sdk-date', dateStamp)
  headers.set('x-sdk-content-sha256', payloadHash)
  headers.set('x-security-token', securityToken)
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value)
  // GET requests carry no body, hence no content-type
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json')

  const signedHeaders = [...headers.keys()].sort()
  const canonicalRequest = buildCanonicalRequest(method, uri, query, headers, payloadHash)
  const canonicalHash = sha256Hex(canonicalRequest)
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`
  const signature = hmacSha256Hex(sk, stringToSign)

  const out: Record<string, string> = {}
  for (const [key, value] of headers) out[key] = value
  out.Authorization = `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`
  return { headers: out, canonicalRequest, signature }
}
