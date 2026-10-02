/**
 * Captcha challenge detection and classification.
 *
 * Strategy ported from the community zcode-api bridge (its captcha-retry /
 * captcha-token seams) — the *detection* logic only, not its solver: upstream
 * signals the challenge in two observed variants:
 *
 *   1. header variant — `x-aliyun-captcha-verify-param` set on a non-2xx
 *      response;
 *   2. in-body variant — HTTP 400 with `{"code":3007,...}` in the JSON body
 *      and no captcha header (observed 2026-08-29, zcode-api PR #38).
 *
 * The body peek reads a bounded CLONE of the response, so the original body
 * stays consumable for the error path.
 */
import type { CaptchaChallenge, CaptchaRejectClass } from './types.js'

export const CAPTCHA_VERIFY_HEADER = 'x-aliyun-captcha-verify-param'
export const CAPTCHA_REGION_HEADER = 'x-aliyun-captcha-verify-region'

/** Magic strings of the in-body 3007 challenge, for both JSON spacing styles. */
const IN_BODY_CHALLENGE_MARKERS = ['"code":3007', '"code": 3007'] as const

/** Bound on how many body bytes a challenge peek reads. */
const MAX_CHALLENGE_PEEK_BYTES = 64 * 1024

/** Bound on decompressed sniff output — error bodies are small; more is waste. */
const MAX_SNIFF_INFLATED_BYTES = 256 * 1024

/** Header variant: a non-2xx response carrying the Aliyun challenge header. */
function headerChallenge(response: Response): CaptchaChallenge | null {
  if (response.ok) return null
  const value = response.headers.get(CAPTCHA_VERIFY_HEADER)
  if (!value || value.trim().length === 0) return null
  return { kind: 'rejected_403', rejectClass: 'unknown', detail: `upstream sent ${CAPTCHA_VERIFY_HEADER}` }
}

/**
 * In-body variant: peek a bounded clone of a non-ok, non-SSE body and detect
 * the `{"code":3007}` marker. Returns null when the response is fine or the
 * body cannot be sniffed.
 */
async function inBodyChallenge(response: Response): Promise<CaptchaChallenge | null> {
  if (response.ok) return null
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) return null
  let bytes: Uint8Array
  try {
    bytes = await peekBodyBytes(response, MAX_CHALLENGE_PEEK_BYTES)
  } catch {
    return null
  }
  if (bytes.byteLength === 0) return null
  const text = await decodeMaybeGzip(bytes, response.headers.get('content-encoding'))
  if (!IN_BODY_CHALLENGE_MARKERS.some((marker) => text.includes(marker))) return null
  return {
    kind: 'in_body_3007',
    rejectClass: classifyReject(text),
    detail: text.slice(0, 200),
  }
}

/** Unified challenge check: header variant first, then the in-body peek. */
export async function detectCaptchaChallenge(response: Response): Promise<CaptchaChallenge | null> {
  return headerChallenge(response) ?? await inBodyChallenge(response)
}

/** Legacy textual heuristic (kept for the 403 path when no header is set). */
export function looksLikeCaptchaText(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('captcha') || lower.includes('verify token') || lower.includes('verify failed')
}

/** Aliyun F008 — certifyId / verify token already consumed or duplicated. */
export function isDuplicateVerifyError(message: string): boolean {
  return /F008|"verifyCode"\s*:\s*"F008"/i.test(message)
}

const IP_BLOCK_RE =
  /too many|request was denied|risk control|frequent|rate\s*limit|exceeded.*(?:request|limit)|ip\s*suspicious|denied due to|retry later/i

/** Aliyun IP-block family: the mint IP has been flagged by risk control. */
export function isIpBlockError(message: string): boolean {
  if (isDuplicateVerifyError(message)) return false
  return IP_BLOCK_RE.test(message)
}

export function classifyReject(message: string): CaptchaRejectClass {
  if (isDuplicateVerifyError(message)) return 'duplicate'
  if (isIpBlockError(message)) return 'ip_block'
  return 'unknown'
}

/** Read at most `limit` bytes from a clone of the response body. */
async function peekBodyBytes(response: Response, limit: number): Promise<Uint8Array> {
  const body = response.clone().body
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      total += value.byteLength
      if (total >= limit) break
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  const all = concat(parts)
  return all.byteLength > limit ? all.subarray(0, limit) : all
}

/**
 * Decode sniff bytes, inflating first when the response is labeled gzip.
 * TextDecoder is non-fatal, so invalid UTF-8 degrades to replacement chars —
 * the ASCII magic strings still match.
 */
async function decodeMaybeGzip(bytes: Uint8Array, encodingHeader: string | null): Promise<string> {
  const encoding = encodingHeader?.toLowerCase().trim() ?? ''
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    try {
      return new TextDecoder().decode(await inflateBounded(bytes))
    } catch {
      // Runtime already inflated the body while keeping the header — sniff
      // the bytes as-is.
    }
  }
  return new TextDecoder().decode(bytes)
}

async function inflateBounded(bytes: Uint8Array): Promise<Uint8Array> {
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const reader = source.pipeThrough(gunzip).getReader()
  const parts: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      total += value.byteLength
      if (total >= MAX_SNIFF_INFLATED_BYTES) break
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return concat(parts)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
