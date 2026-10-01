/**
 * Cline protocol primitives.
 *
 * Verified shapes (jet-hub cline.ts / cline-oauth.ts, 2026-09-25):
 * - device code: POST {workOsBase}/user_management/authorize/device (form body)
 * - poll:        POST {workOsBase}/user_management/authenticate
 *                `error: "authorization_pending"` is NOT a failure — keep polling;
 *                `error: "slow_down"` must back off by one interval.
 * - register:    POST {apiBase}/api/v1/auth/register {accessToken, refreshToken}
 *                → `{success:true, data:{accessToken, refreshToken, expiresAt, userInfo}}`
 * - refresh:     POST {apiBase}/api/v1/auth/refresh {refreshToken, grantType}
 *                (camelCase, non-standard)
 * - chat:        OpenAI-compatible SSE; `Authorization: Bearer workos:<jwt>`
 */
import type { ClineProduct } from './product.js'

export type Fetcher = typeof fetch

/** Persisted Cline credential (snake_case, gateway convention). */
export interface ClineCredential {
  access_token: string
  refresh_token?: string
  /** ms timestamp; upstream sends an ISO string which is normalized here. */
  expires_at?: string
  user_id?: string
  email?: string
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Parse the upstream `expiresAt` (ISO string, seconds or ms number) → ms. */
export function parseClineTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  if (typeof value === 'string' && value !== '') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) return asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

export interface ClineTokenPayload {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  clineUserId?: string
  email?: string
}

/**
 * Parse a register/refresh response. The success criterion is
 * `success === true && data.accessToken`; a bare `accessToken` is also accepted
 * for upstream-format robustness. Returns undefined when there is no token.
 */
export function parseClineTokenPayload(body: unknown): ClineTokenPayload | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const root = body as Record<string, unknown>
  const inner =
    typeof root.data === 'object' && root.data !== null
      ? (root.data as Record<string, unknown>)
      : root
  const accessToken = readString(inner, ['accessToken', 'access_token'])
  if (!accessToken) return undefined
  const userInfo =
    typeof inner.userInfo === 'object' && inner.userInfo !== null
      ? (inner.userInfo as Record<string, unknown>)
      : {}
  return {
    accessToken,
    refreshToken: readString(inner, ['refreshToken', 'refresh_token']),
    expiresAt: parseClineTimestamp(inner.expiresAt ?? inner.expires_at ?? inner.expire_time),
    clineUserId: readString(userInfo, ['clineUserId', 'id']) ?? readString(inner, ['clineUserId', 'userId']),
    email: readString(userInfo, ['email']) ?? readString(inner, ['email']),
  }
}

export function buildClineCredential(
  payload: ClineTokenPayload,
  base: Partial<ClineCredential> = {},
): ClineCredential {
  const expiresAt = payload.expiresAt ?? (base.expires_at ? Number(base.expires_at) : undefined)
  return {
    access_token: payload.accessToken,
    ...(payload.refreshToken ?? base.refresh_token
      ? { refresh_token: payload.refreshToken ?? base.refresh_token }
      : {}),
    ...(expiresAt ? { expires_at: String(expiresAt) } : {}),
    ...(payload.clineUserId ?? base.user_id ? { user_id: payload.clineUserId ?? base.user_id } : {}),
    ...(payload.email ?? base.email ? { email: payload.email ?? base.email } : {}),
  }
}

export function isClineRefreshable(credential: ClineCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
}

export function clineCredentialExpiresAtMs(credential: ClineCredential): number | undefined {
  const raw = credential.expires_at
  if (raw === undefined || raw === '') return undefined
  return parseClineTimestamp(raw)
}

/** Refresh body — camelCase `refreshToken` / `grantType` (non-standard). */
export function clineRefreshBody(credential: ClineCredential): Record<string, string> {
  return { refreshToken: credential.refresh_token ?? '', grantType: 'refresh_token' }
}

// -- headers ----------------------------------------------------------------
/**
 * The access token already carries its `workos:` prefix; the bearer value must
 * keep it (`Bearer workos:<jwt>`).
 */
export function clineBearerValue(accessToken: string, product: ClineProduct): string {
  return accessToken.startsWith(product.tokenPrefix)
    ? accessToken
    : `${product.tokenPrefix}${accessToken}`
}

export function clineChatHeaders(credential: ClineCredential, product: ClineProduct): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${clineBearerValue(credential.access_token, product)}`,
    ...product.clientHeaders,
  }
}

export function clineAuthHeaders(credential: ClineCredential, product: ClineProduct): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${clineBearerValue(credential.access_token, product)}`,
    ...product.clientHeaders,
  }
}

export function clineAnonymousHeaders(product: ClineProduct): Record<string, string> {
  return { 'Content-Type': 'application/json', Accept: 'application/json', ...product.clientHeaders }
}

// -- device code ------------------------------------------------------------
export interface ClineDeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresInMs: number
  intervalMs: number
}

/** Normalize the WorkOS device-authorization response. */
export function parseClineDeviceAuthorization(body: unknown): ClineDeviceAuthorization | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const deviceCode = readString(record, ['device_code', 'deviceCode'])
  const verificationUri = readString(record, ['verification_uri', 'verificationUri'])
  if (!deviceCode || !verificationUri) return undefined
  const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : 300
  const interval = typeof record.interval === 'number' ? record.interval : 5
  return {
    deviceCode,
    userCode: readString(record, ['user_code', 'userCode']) ?? '',
    verificationUri,
    verificationUriComplete: readString(record, ['verification_uri_complete', 'verificationUriComplete']),
    expiresInMs: expiresIn * 1000,
    intervalMs: interval * 1000,
  }
}

/** Outcome of one device-code poll attempt. */
export type ClinePollOutcome =
  | { status: 'pending' }
  | { status: 'slow_down'; intervalMs: number }
  | { status: 'denied'; error: string }
  | { status: 'token'; accessToken: string; refreshToken?: string }

/**
 * Classify a device-code poll response.
 * `authorization_pending` keeps polling; `slow_down` backs off; other error
 * codes are terminal. A missing error with an access token is success.
 */
export function classifyClinePoll(status: number, body: unknown): ClinePollOutcome {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const error = typeof record.error === 'string' ? record.error : undefined
  if (error === 'authorization_pending') return { status: 'pending' }
  if (error === 'slow_down') return { status: 'slow_down', intervalMs: 1000 }
  if (error !== undefined) return { status: 'denied', error }
  const accessToken = typeof record.access_token === 'string' ? record.access_token : undefined
  if (accessToken) {
    return {
      status: 'token',
      accessToken,
      ...(typeof record.refresh_token === 'string' ? { refreshToken: record.refresh_token } : {}),
    }
  }
  // No error and no token: treat a 2xx as pending, anything else as terminal.
  if (status >= 200 && status < 300) return { status: 'pending' }
  return { status: 'denied', error: `HTTP ${status}` }
}
