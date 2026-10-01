/**
 * Loomy (讯飞办公助手) protocol primitives.
 *
 * Verified reference (jet-hub src/loomy*.ts):
 * - account/session: `https://account.xfinfr.com`, HMAC-SHA1 `account ak:sig`
 * - business/inference: `https://loomyad.xunfei.cn/api/v1`
 * - `POST {accountBase}/login/phone/sendMsgCode {base, param:{ccode,phone,expire:300}}`
 * - `POST {accountBase}/login/phone/checkCode   {base, param:{ccode,phone,mcode,msgid,expire:1209600}}`
 * - `POST {apiBase}/chat/completions` (standard OpenAI SSE; Bearer)
 * - `GET  {apiBase}/models` (only the lowercase `token` header is accepted)
 * - `GET  {apiBase}/points/records?…`, `POST {apiBase}/points/first-login`
 *
 * Loomy has **no refresh endpoint**: the `session` is declared valid for 14 days
 * at login, after which re-login is required. `isLoomyRefreshable()` is
 * therefore honestly `false`.
 */
import type { LoomyProduct } from './product.js'

export type Fetcher = typeof fetch

/** Persisted Loomy credential. */
export interface LoomyCredential {
  /** iFlytek `session` (32 lowercase hex) — also doubles as the bearer token */
  access_token: string
  /** ms timestamp string; absent means "no known expiry" (treated as valid) */
  expires_at?: string
  uid?: string
  nickname?: string
  phone?: string
}

export const LOOMY_OK_CODE = '000000'
export const LOOMY_AUTH_ERROR_CODE = '100002'
export const LOOMY_BAD_REQUEST_CODE = '100001'

export function isLoomyExpired(credential: LoomyCredential): boolean {
  const raw = credential.expires_at
  if (typeof raw !== 'string' || raw.trim() === '') return false
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= Date.now()
}

/** Loomy has no refresh endpoint — this is an honest constant. */
export function isLoomyRefreshable(): boolean {
  return false
}

/** Business-endpoint headers: only the lowercase `token` header is accepted. */
export function loomyBusinessHeaders(token: string): Record<string, string> {
  return { Accept: 'application/json', token }
}

/** Chat headers: both the Bearer and `token` forms (the client sends both). */
export function loomyChatHeaders(token: string): Record<string, string> {
  return {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    token,
  }
}

/** Parse the `{code, data}` account envelope; `code !== '000000'` is failure. */
export function parseLoomyEnvelope(body: unknown): { ok: boolean; code: string; data: Record<string, unknown> } {
  if (typeof body !== 'object' || body === null) return { ok: false, code: '', data: {} }
  const record = body as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code : ''
  const data =
    typeof record.data === 'object' && record.data !== null ? (record.data as Record<string, unknown>) : {}
  return { ok: code === LOOMY_OK_CODE, code, data }
}

export interface LoomyModel {
  id: string
  name: string
}

/**
 * Parse `GET /models`, keeping only `type === 'chat'` entries.
 * `output_modalities` is deliberately not used: input multimodal models are
 * still chat models.
 */
export function parseLoomyModels(body: unknown): LoomyModel[] {
  const envelope = parseLoomyEnvelope(body)
  const list = Array.isArray(envelope.data.data)
    ? envelope.data.data
    : Array.isArray(envelope.data.models)
      ? envelope.data.models
      : Array.isArray(body)
        ? (body as unknown[])
        : []
  const models: LoomyModel[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id || record.type !== 'chat') continue
    const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name : id
    models.push({ id, name })
  }
  return models
}

/** Build the SMS login bodies (kept here so both steps share one shape). */
export function loomySendCodeBody(phone: string, ccode = '86'): Record<string, unknown> {
  return { base: {}, param: { ccode, phone, expire: 300 } }
}

export function loomyCheckCodeBody(
  phone: string,
  mcode: string,
  msgid: string,
  ccode = '86',
): Record<string, unknown> {
  // expire 1209600 = 14 days, declared to the server at login
  return { base: {}, param: { ccode, phone, mcode, msgid, expire: 1_209_600 } }
}

export { type LoomyProduct }
