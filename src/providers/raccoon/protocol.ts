/**
 * Raccoon protocol primitives.
 *
 * Verified reference (jet-hub src/raccoon.ts / raccoon-oauth.ts).
 *
 * Login policy: only the **WeChat QR** path is implemented. The SMS path needs
 * an Aliyun slider captcha (`captcha_param`) that this gateway will not solve or
 * bypass, so it is reported as `needs_manual_action` instead.
 */
import { randomBytes } from 'node:crypto'
import type { RaccoonProduct } from './product.js'

export type Fetcher = typeof fetch

/** Persisted Raccoon credential. */
export interface RaccoonCredential {
  access_token: string
  refresh_token: string
  expires_at?: string
  nickname?: string
  uid?: string
  /** `X-Org-Code` value */
  office_identity?: string
  device_id?: string
}

/**
 * QR login status. Any anomaly degrades to `pending` (network hiccups, malformed
 * responses, unknown status) so polling never fails spuriously.
 */
export type RaccoonQrStatus = 'pending' | 'logging' | 'canceled' | 'success'

/** A 32-hex-lowercase QR code (16 random bytes). */
export function generateQrCode(): string {
  return randomBytes(16).toString('hex')
}

/** The public WeChat login page the QR image encodes. */
export function buildQrImageUrl(product: RaccoonProduct, code: string): string {
  const params = new URLSearchParams({ code, appname: '商汤小浣熊官网' })
  return `${product.apiBase}/login/mp?${params.toString()}`
}

export function isRaccoonRefreshable(credential: RaccoonCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.trim().length > 0
}

/** Decode a JWT `exp` locally (Raccoon access tokens are JWTs). */
export function decodeJwtExpMs(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    const exp = payload.exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

export function raccoonCredentialExpiresAtMs(credential: RaccoonCredential): number | undefined {
  const raw = credential.expires_at
  if (raw !== undefined && raw !== '') {
    const value = Number(raw)
    if (Number.isFinite(value)) return value > 1_000_000_000_000 ? value : value * 1000
  }
  return decodeJwtExpMs(credential.access_token)
}

export function isRaccoonExpired(credential: RaccoonCredential): boolean {
  const expiresAt = raccoonCredentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : Date.now() >= expiresAt
}

/** Parse the `{code, data}` envelope; `code !== 0` is failure. */
export function parseRaccoonEnvelope(body: unknown): { ok: boolean; code: number; data: Record<string, unknown> } {
  if (typeof body !== 'object' || body === null) return { ok: false, code: -1, data: {} }
  const record = body as Record<string, unknown>
  const code = typeof record.code === 'number' ? record.code : -1
  const data =
    typeof record.data === 'object' && record.data !== null ? (record.data as Record<string, unknown>) : {}
  return { ok: code === 0, code, data }
}

/**
 * Merge a login/refresh response into a credential.
 * A refresh response may omit `refresh_token`; the previous value is kept, since
 * dropping it would make the account non-refreshable after a single rotation.
 */
export function mergeRaccoonCredential(
  data: Record<string, unknown>,
  base: Partial<RaccoonCredential> = {},
): RaccoonCredential {
  const accessToken = typeof data.access_token === 'string' ? data.access_token : (base.access_token ?? '')
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : (base.refresh_token ?? '')
  // prefer the JWT exp; only fall back to a server-provided expiry
  const expMs = decodeJwtExpMs(accessToken)
  const serverExp = typeof data.expires_at === 'string' || typeof data.expires_at === 'number'
    ? String(data.expires_at)
    : undefined
  const expiresAt = expMs !== undefined ? String(expMs) : (serverExp ?? base.expires_at)
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(typeof data.nickname === 'string' ? { nickname: data.nickname } : base.nickname ? { nickname: base.nickname } : {}),
    ...(typeof data.user_id === 'string' ? { uid: data.user_id } : base.uid ? { uid: base.uid } : {}),
    ...(typeof data.office_identity === 'string'
      ? { office_identity: data.office_identity }
      : base.office_identity
        ? { office_identity: base.office_identity }
        : {}),
    ...(base.device_id ? { device_id: base.device_id } : {}),
  }
}

export interface RaccoonModel {
  id: string
  name: string
}

/**
 * Parse `GET /api/web/llm/v2/model_catalog`, keeping only `visible: true`
 * entries. An unreadable catalog returns nothing so the caller falls back.
 */
export function parseRaccoonModelCatalog(body: unknown): RaccoonModel[] {
  if (typeof body !== 'object' || body === null) return []
  const envelope = parseRaccoonEnvelope(body)
  const root = envelope.ok ? envelope.data : (body as Record<string, unknown>)
  const list = Array.isArray(root.models)
    ? root.models
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.model_list)
        ? root.model_list
        : []
  const models: RaccoonModel[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : typeof record.model === 'string' ? record.model : undefined
    if (!id) continue
    if (record.visible === false) continue
    const name = typeof record.name === 'string' ? record.name : typeof record.display_name === 'string' ? record.display_name : id
    models.push({ id, name })
  }
  return models
}

/** Auth headers for llm/points endpoints (Bearer + org code + language). */
export function raccoonAuthHeaders(credential: RaccoonCredential, product: RaccoonProduct): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.access_token}`,
    'X-Org-Code': credential.office_identity ?? '',
    'X-Raccoon-Language': 'zh',
    'User-Agent': product.userAgent,
  }
}

export { type RaccoonProduct }
