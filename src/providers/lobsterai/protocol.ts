/**
 * LobsterAI protocol primitives: credentials, headers, envelope parsing, model
 * list parsing and the client-version resolver.
 *
 * Pure functions only (network I/O lives in provider.ts) so every shape is
 * unit-testable. Endpoints and header values come from the verified reference
 * (jet-hub src/lobsterai.ts); nothing here is guessed.
 */
import { randomUUID } from 'node:crypto'
import type { LobsteraiProduct } from './product.js'

// -- endpoint paths ---------------------------------------------------------
export const LOBSTERAI_EXCHANGE_PATH = '/api/auth/exchange'
export const LOBSTERAI_REFRESH_PATH = '/api/auth/refresh'
export const LOBSTERAI_MODELS_PATH = '/api/models/available'
export const LOBSTERAI_CHAT_PATH = '/api/proxy/v1/chat/completions'
export const LOBSTERAI_PROFILE_SUMMARY_PATH = '/api/user/profile-summary'
export const LOBSTERAI_ACTIVITY_SLOT_PATH = '/api/client-activities/slot'
export const LOBSTERAI_ACTIVITY_CONTEXT_PATH = '/api/client-activities'

export const LOBSTERAI_REQUEST_TIMEOUT_MS = 30_000
export const LOBSTERAI_VERSION_CACHE_TTL_MS = 12 * 60 * 60 * 1000

export type Fetcher = typeof fetch

/**
 * Persisted LobsterAI credential.
 *
 * snake_case mirrors the reference `LobsteraiCredential` so the account pool's
 * generic `access_token` identity lookup keeps working unchanged.
 */
export interface LobsteraiCredential {
  access_token: string
  refresh_token: string
  /** expiry as a **millisecond timestamp string** (matches Buddy convention). */
  expires_at?: string
  uid?: string
  user_id?: string
  nickname?: string
  /** install UUID; must be echoed on refresh, never regenerated. */
  uuid?: string
  first_keyfrom?: string
  latest_keyfrom?: string
}

// -- envelope ---------------------------------------------------------------
export interface LobsteraiEnvelope {
  ok: boolean
  code: number
  data: Record<string, unknown>
  message: string
}

/** Parse the uniform `{code, msg, data}` envelope (`code !== 0` means failure). */
export function parseLobsteraiEnvelope(body: unknown): LobsteraiEnvelope {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, code: -1, data: {}, message: 'response is not a JSON object' }
  }
  const record = body as Record<string, unknown>
  const code = typeof record.code === 'number' ? record.code : -1
  const message =
    typeof record.msg === 'string' && record.msg.length > 0
      ? record.msg
      : typeof record.message === 'string'
        ? record.message
        : ''
  const data =
    typeof record.data === 'object' && record.data !== null
      ? (record.data as Record<string, unknown>)
      : {}
  return { ok: code === 0, code, data, message }
}

// -- identity payload -------------------------------------------------------
/** Build the `keyfrom` identity payload shared by exchange / refresh. */
export function lobsteraiKeyfromBody(
  credential: LobsteraiCredential,
  clientVersion: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    firstKeyfrom: credential.first_keyfrom ?? '',
    // the stored value is echoed verbatim (the reference never rewrites it)
    latestKeyfrom: credential.latest_keyfrom ?? '',
    version: clientVersion,
  }
  if (credential.uuid) body.uuid = credential.uuid
  if (credential.user_id) body.userId = credential.user_id
  return body
}

/** Refresh body = keyfrom payload + refreshToken. */
export function lobsteraiRefreshBody(
  credential: LobsteraiCredential,
  clientVersion: string,
): Record<string, unknown> {
  return { ...lobsteraiKeyfromBody(credential, clientVersion), refreshToken: credential.refresh_token }
}

// -- headers ----------------------------------------------------------------
export function lobsteraiAnonymousHeaders(product: LobsteraiProduct): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': product.userAgent,
  }
}

function authHeaders(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  accept: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.access_token}`,
    Accept: accept,
    'Content-Type': 'application/json',
    'User-Agent': product.userAgent,
  }
}

/** Chat headers: SSE accept + the two `X-LobsterAI-Client-*` identity headers. */
export function lobsteraiChatHeaders(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  clientVersion: string,
): Record<string, string> {
  return {
    ...authHeaders(credential, product, 'text/event-stream, application/json'),
    'X-LobsterAI-Client-Capabilities': product.clientCapabilities,
    'X-LobsterAI-Client-Version': clientVersion,
  }
}

/**
 * Model-list headers. The client-capabilities header is **required** here: the
 * backend filters the model set by it (`kimi-k3` is absent without it).
 */
export function lobsteraiModelsHeaders(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  clientVersion: string,
): Record<string, string> {
  return {
    ...authHeaders(credential, product, 'application/json'),
    'X-LobsterAI-Client-Capabilities': product.clientCapabilities,
    'X-LobsterAI-Client-Version': clientVersion,
  }
}

/** Plain authenticated headers (balance / activities). */
export function lobsteraiAuthHeaders(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
): Record<string, string> {
  return authHeaders(credential, product, 'application/json')
}

// -- token payload ----------------------------------------------------------
export interface LobsteraiTokenPayload {
  accessToken: string
  refreshToken: string
  expiresIn?: number
  userId?: string
  yid?: string
  accountUserId?: string
  nickname?: string
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Parse the token + user portion of an exchange / refresh response. */
export function parseLobsteraiTokenPayload(data: Record<string, unknown>): LobsteraiTokenPayload | undefined {
  const accessToken = readString(data, 'accessToken')
  if (!accessToken) return undefined
  const user =
    typeof data.user === 'object' && data.user !== null ? (data.user as Record<string, unknown>) : {}
  return {
    accessToken,
    refreshToken: readString(data, 'refreshToken') ?? '',
    expiresIn: readNumber(data, 'expiresIn'),
    userId: readString(user, 'id'),
    yid: readString(user, 'yid'),
    accountUserId: readString(user, 'userId'),
    nickname: readString(user, 'nickname') ?? readString(user, 'name'),
  }
}

/** Merge a token payload into a persisted credential (preserving install id). */
export function buildLobsteraiCredential(
  payload: LobsteraiTokenPayload,
  base: Partial<LobsteraiCredential>,
  nowMs: number = Date.now(),
): LobsteraiCredential {
  const expiresAt =
    payload.expiresIn !== undefined && payload.expiresIn > 0
      ? String(nowMs + payload.expiresIn * 1000)
      : base.expires_at
  return {
    access_token: payload.accessToken,
    refresh_token: payload.refreshToken || (base.refresh_token ?? ''),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(payload.userId ?? base.uid ? { uid: payload.userId ?? base.uid } : {}),
    ...(payload.accountUserId ?? base.user_id ? { user_id: payload.accountUserId ?? base.user_id } : {}),
    ...(payload.yid ?? base.uid ? { uid: payload.yid ?? base.uid } : {}),
    ...(payload.nickname ?? base.nickname ? { nickname: payload.nickname ?? base.nickname } : {}),
    ...(base.uuid ? { uuid: base.uuid } : {}),
    ...(base.first_keyfrom ? { first_keyfrom: base.first_keyfrom } : {}),
    ...(base.latest_keyfrom ? { latest_keyfrom: base.latest_keyfrom } : {}),
  }
}

export function isLobsteraiRefreshable(credential: LobsteraiCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
}

export function lobsteraiCredentialExpiresAtMs(credential: LobsteraiCredential): number | undefined {
  const raw = credential.expires_at
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (Number.isFinite(value)) return value > 1_000_000_000_000 ? value : value * 1000
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function isLobsteraiExpired(credential: LobsteraiCredential): boolean {
  const expiresAt = lobsteraiCredentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : Date.now() >= expiresAt
}

/** One-time install identity generated at login and echoed on every refresh. */
export interface LobsteraiLoginSession {
  uuid: string
  firstKeyfrom: string
}

export function createLobsteraiLoginSession(nowMs: number = Date.now()): LobsteraiLoginSession {
  return { uuid: randomUUID(), firstKeyfrom: String(nowMs) }
}

/** Portal login URL (`{portal}/portal#/login?source=electron&...`). */
export function buildLobsteraiLoginUrl(
  port: number,
  state: string,
  product: LobsteraiProduct,
): string {
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`
  const query = new URLSearchParams({ source: 'electron', redirect_uri: redirectUri, state })
  return `${product.portalBase}/portal#/login?${query.toString()}`
}

// -- model catalog ----------------------------------------------------------
export interface LobsteraiRemoteModel {
  id: string
  name: string
  contextWindow?: number
}

/** Parse `GET /api/models/available` (accepts both `models[]` and `list[]`). */
export function parseLobsteraiModels(body: unknown): LobsteraiRemoteModel[] {
  const envelope = parseLobsteraiEnvelope(body)
  const data = envelope.ok ? envelope.data : (body as Record<string, unknown>)
  const raw = Array.isArray(data.models)
    ? data.models
    : Array.isArray(data.list)
      ? data.list
      : Array.isArray(data)
        ? (data as unknown[])
        : []
  const models: LobsteraiRemoteModel[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = readString(record, 'id') ?? readString(record, 'model')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = readString(record, 'name') ?? readString(record, 'displayName') ?? id
    const contextWindow = readNumber(record, 'contextWindow') ?? readNumber(record, 'maxInputTokens')
    models.push({ id, name, ...(contextWindow ? { contextWindow } : {}) })
  }
  return models
}

// -- client version ---------------------------------------------------------
const VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d{1,2}$/

/** Extract `data.value.version` from the update endpoint (not enveloped). */
export function parseClientVersionFromUpdate(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const data = (body as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return undefined
  const value = (data as Record<string, unknown>).value
  if (typeof value !== 'object' || value === null) return undefined
  const version = (value as Record<string, unknown>).version
  return typeof version === 'string' && VERSION_PATTERN.test(version) ? version : undefined
}

/** Resolves + caches the dynamic client version (12h TTL, falls back safely). */
export class LobsteraiClientVersionResolver {
  private cached?: string
  private cachedAt = 0
  constructor(
    private readonly product: LobsteraiProduct,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(): Promise<{ version: string; source: 'cache' | 'remote' | 'fallback' }> {
    if (this.cached !== undefined && this.now() - this.cachedAt < LOBSTERAI_VERSION_CACHE_TTL_MS) {
      return { version: this.cached, source: 'cache' }
    }
    try {
      const res = await this.fetcher(this.product.clientVersionApi, {
        headers: { Accept: 'application/json', 'User-Agent': this.product.userAgent },
      })
      if (res.ok) {
        const version = parseClientVersionFromUpdate(await res.json())
        if (version !== undefined) {
          this.cached = version
          this.cachedAt = this.now()
          return { version, source: 'remote' }
        }
      }
    } catch {
      // fall through to the fallback below
    }
    return { version: this.product.fallbackClientVersion, source: 'fallback' }
  }
}
