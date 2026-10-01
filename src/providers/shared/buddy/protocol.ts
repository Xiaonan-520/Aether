/**
 * Tencent Buddy-family protocol (CodeBuddy / WorkBuddy): external-link-v2
 * polling login, silent refresh, model catalog and OpenAI-compatible chat.
 *
 * Extracted from the DSH `buddy.ts` / `buddy-oauth.ts` reference and stripped
 * of all DSH framework coupling (`ctx.*`, `LlmError`, Jet Hub UI). Only the
 * protocol remains; every network call accepts an injected fetcher so the
 * Gateway can test it without touching the network.
 */
import {
  AUTH_REFRESH_SOURCE,
  CHAT_PATH,
  CODE_ACCOUNT_NOT_READY,
  CODE_TOKEN_NOT_READY,
  HTTP_HEADER_AUTH_REFRESH_SOURCE,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_ENTERPRISE_ID,
  HTTP_HEADER_NO_AUTHORIZATION,
  HTTP_HEADER_NO_DEPARTMENT_INFO,
  HTTP_HEADER_NO_ENTERPRISE_ID,
  HTTP_HEADER_NO_USER_ID,
  HTTP_HEADER_REFRESH_TOKEN,
  HTTP_HEADER_TENANT_ID,
} from './constants.js'
import { resolveUserAgent, type BuddyProduct } from './product.js'

export interface BuddyToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
  refreshExpiresAt: number
  tokenType: string
  scope: string
  domain: string
}

export interface BuddyAccount {
  uid: string
  nickname: string
  enterpriseId: string
  accountType: string
}

/** The serialized credential stored (encrypted) by the Gateway. */
export interface BuddyCredential {
  access_token: string
  refresh_token: string
  expires_at: number
  refresh_expires_at: number
  token_type: string
  scope: string
  domain: string
  user_id: string
  nickname: string
  enterprise_id: string
  account_type: string
}

export interface BuddyRemoteModel {
  id: string
  name: string
}

export type Fetcher = typeof fetch

export class BuddyRefreshExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuddyRefreshExpiredError'
  }
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value === 'string') return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function responseData(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  const data = (body as Record<string, unknown>).data
  return data === null ? undefined : data
}

function responseCode(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0
  const code = (body as Record<string, unknown>).code
  return typeof code === 'number' ? code : 0
}

function responseMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const message = (body as Record<string, unknown>).message
  return typeof message === 'string' ? message : ''
}

async function request(
  fetcher: Fetcher,
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const composed = signal ? AbortSignal.any([timeout, signal]) : timeout
  let response: Response
  try {
    response = await fetcher(url, { method, headers, signal: composed })
  } catch (error) {
    throw new Error(`buddy ${method} ${url} network error: ${String(error)}`)
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

// ---------------------------------------------------------------------------
// JWT helpers (no verification — only payload inspection for expiry/nickname)
// ---------------------------------------------------------------------------

function jwtPayload(token: string): Record<string, unknown> | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function jwtExpiresAtMs(token: string): number | undefined {
  const payload = jwtPayload(token)
  if (!payload) return undefined
  const exp = payload.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
}

export function jwtNickname(token: string): string {
  const payload = jwtPayload(token)
  if (!payload) return ''
  for (const key of ['nickname', 'preferred_username', 'name']) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

function jwtSubject(token: string): string {
  const payload = jwtPayload(token)
  const sub = payload?.sub
  return typeof sub === 'string' ? sub : ''
}

// ---------------------------------------------------------------------------
// Token / account / credential parsing
// ---------------------------------------------------------------------------

function absoluteExpiryMs(record: Record<string, unknown>, absoluteKey: string, relativeKey: string, token: string): number {
  const absolute = record[absoluteKey]
  if (typeof absolute === 'number' && Number.isFinite(absolute)) return absolute
  if (typeof absolute === 'string' && absolute.trim() !== '' && /^\d+$/.test(absolute.trim())) return Number(absolute.trim())
  const relative = record[relativeKey]
  if (typeof relative === 'number' && Number.isFinite(relative)) return Date.now() + relative * 1000
  if (typeof relative === 'string' && /^\d+$/.test(relative.trim())) return Date.now() + Number(relative.trim()) * 1000
  return jwtExpiresAtMs(token) ?? 0
}

export function parseTokenData(data: unknown): BuddyToken {
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  const accessToken = readString(record, 'accessToken')
  return {
    accessToken,
    refreshToken: readString(record, 'refreshToken'),
    expiresAt: absoluteExpiryMs(record, 'expiresAt', 'expiresIn', accessToken),
    refreshExpiresAt: absoluteExpiryMs(record, 'refreshExpiresAt', 'refreshExpiresIn', accessToken),
    tokenType: readString(record, 'tokenType') || 'Bearer',
    scope: readString(record, 'scope'),
    domain: readString(record, 'domain'),
  }
}

export function parseAccountData(data: unknown): BuddyAccount {
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  return {
    uid: readString(record, 'uid'),
    nickname: readString(record, 'nickname'),
    enterpriseId: readString(record, 'enterpriseId'),
    accountType: readString(record, 'type') || 'personal',
  }
}

export function buildCredential(token: BuddyToken, account: BuddyAccount): BuddyCredential {
  return {
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    refresh_expires_at: token.refreshExpiresAt,
    token_type: token.tokenType,
    scope: token.scope,
    domain: token.domain,
    user_id: account.uid || jwtSubject(token.accessToken),
    nickname: account.nickname || jwtNickname(token.accessToken),
    enterprise_id: account.enterpriseId,
    account_type: account.accountType,
  }
}

export function isRefreshable(credential: BuddyCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
}

/** Access-token expiry from the stored fields (falls back to the JWT exp). */
export function credentialExpiresAtMs(credential: BuddyCredential): number | undefined {
  if (typeof credential.expires_at === 'number' && credential.expires_at > 0) return credential.expires_at
  return jwtExpiresAtMs(credential.access_token)
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

export function credentialRequestHeaders(credential: BuddyCredential, product: BuddyProduct): Record<string, string> {
  const headers: Record<string, string> = {
    [HTTP_HEADER_DOMAIN]: credential.domain || product.apiDomain,
    'User-Agent': product.userAgent,
  }
  if (credential.enterprise_id) {
    headers[HTTP_HEADER_ENTERPRISE_ID] = credential.enterprise_id
    headers[HTTP_HEADER_TENANT_ID] = credential.enterprise_id
  }
  return headers
}

export function credentialAuthHeaders(credential: BuddyCredential, product: BuddyProduct): Record<string, string> {
  return { ...credentialRequestHeaders(credential, product), Authorization: `Bearer ${credential.access_token}` }
}

// ---------------------------------------------------------------------------
// Auth flow: state → browser → token poll → account poll → refresh
// ---------------------------------------------------------------------------

export interface AuthState {
  state: string
  authUrl: string
}

export async function fetchAuthState(
  product: BuddyProduct,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<AuthState> {
  const url = `${product.endpoint}/v2/plugin/auth/state?platform=${product.platform}`
  const headers: Record<string, string> = {
    [HTTP_HEADER_DOMAIN]: product.apiDomain,
    [HTTP_HEADER_NO_AUTHORIZATION]: 'true',
    [HTTP_HEADER_NO_USER_ID]: 'true',
    [HTTP_HEADER_NO_ENTERPRISE_ID]: 'true',
    [HTTP_HEADER_NO_DEPARTMENT_INFO]: 'true',
    'User-Agent': product.userAgent,
  }
  const { status, body } = await request(fetcher, 'POST', url, headers, 5_000, signal)
  if (status !== 200) throw new Error(`auth/state HTTP ${status}: ${responseMessage(body)}`)
  const data = responseData(body)
  if (typeof data !== 'object' || data === null) throw new Error('auth/state response missing data')
  const record = data as Record<string, unknown>
  const state = typeof record.state === 'string' ? record.state : ''
  const authUrl = typeof record.authUrl === 'string' ? record.authUrl : ''
  if (!state) throw new Error('auth/state response missing state')
  if (!authUrl) throw new Error('auth/state response missing authUrl')
  return { state, authUrl }
}

/** `GET /v2/plugin/auth/token?state=` — one poll. 11217 = not ready yet. */
export async function pollTokenOnce(
  product: BuddyProduct,
  state: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<{ ready: boolean; token?: BuddyToken }> {
  const url = `${product.endpoint}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`
  const headers: Record<string, string> = {
    [HTTP_HEADER_NO_AUTHORIZATION]: 'true',
    'User-Agent': product.userAgent,
  }
  const { status, body } = await request(fetcher, 'GET', url, headers, 60_000, signal)
  if (status === 200) {
    const data = responseData(body)
    if (data !== undefined) return { ready: true, token: parseTokenData(data) }
    return { ready: false }
  }
  if (responseCode(body) === CODE_TOKEN_NOT_READY) return { ready: false }
  throw new Error(`auth/token HTTP ${status} code=${responseCode(body)}: ${responseMessage(body)}`)
}

/** `GET /v2/plugin/login/account?state=` — one poll (needs Bearer). 12151 = not ready. */
export async function pollAccountOnce(
  product: BuddyProduct,
  state: string,
  accessToken: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<{ ready: boolean; account?: BuddyAccount }> {
  const url = `${product.endpoint}/v2/plugin/login/account?state=${encodeURIComponent(state)}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': product.userAgent,
  }
  const { status, body } = await request(fetcher, 'GET', url, headers, 60_000, signal)
  if (status === 200) {
    const data = responseData(body)
    if (data !== undefined) return { ready: true, account: parseAccountData(data) }
    return { ready: false }
  }
  if (responseCode(body) === CODE_ACCOUNT_NOT_READY) return { ready: false }
  throw new Error(`login/account HTTP ${status} code=${responseCode(body)}: ${responseMessage(body)}`)
}

/** `POST /v2/plugin/auth/token/refresh` — silent renewal. */
export async function refreshBuddyToken(
  product: BuddyProduct,
  credential: BuddyCredential,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<BuddyToken> {
  if (!isRefreshable(credential)) throw new BuddyRefreshExpiredError('no refresh_token; re-login required')
  const url = `${product.endpoint}/v2/plugin/auth/token/refresh`
  const headers: Record<string, string> = {
    ...credentialRequestHeaders(credential, product),
    Authorization: `Bearer ${credential.access_token}`,
    [HTTP_HEADER_REFRESH_TOKEN]: credential.refresh_token,
    [HTTP_HEADER_AUTH_REFRESH_SOURCE]: AUTH_REFRESH_SOURCE,
  }
  const { status, body } = await request(fetcher, 'POST', url, headers, 60_000, signal)
  if (status !== 200) {
    const code = responseCode(body)
    const message = responseMessage(body)
    const expired = status === 401 || status === 403 || code === 401 || code === 403
      || message.includes('expired') || message.includes('invalid')
    if (expired) throw new BuddyRefreshExpiredError(message || `HTTP ${status}`)
    throw new Error(`refresh HTTP ${status} code=${code}: ${message}`)
  }
  const data = responseData(body)
  if (data === undefined) throw new Error('refresh response missing data')
  return parseTokenData(data)
}

// ---------------------------------------------------------------------------
// Model catalog: GET /v3/config
// ---------------------------------------------------------------------------

/** Parse the model ids out of a /v3/config payload. */
export function parseModelsFromConfig(body: unknown): BuddyRemoteModel[] {
  const data = responseData(body) ?? body
  const out: BuddyRemoteModel[] = []
  const seen = new Set<string>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    const id = record.id ?? record.modelId ?? record.model_id
    if (typeof id === 'string' && id.length > 0 && /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !seen.has(id)) {
      // A model id must look like a model, never a config section name.
      if (/^(model|models|config|configs|data|list|enabled)$/i.test(id)) {
        // skip container keys
      } else {
        seen.add(id)
        const name = record.name ?? record.displayName ?? record.display_name
        out.push({ id, name: typeof name === 'string' && name.length > 0 ? name : id })
      }
    }
    for (const value of Object.values(record)) visit(value)
  }
  visit(data)
  return out
}

export async function fetchBuddyModels(
  product: BuddyProduct,
  credential: BuddyCredential,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<BuddyRemoteModel[]> {
  const url = `${product.endpoint}/v3/config`
  const headers = credentialAuthHeaders(credential, product)
  const { status, body } = await request(fetcher, 'GET', url, headers, 30_000, signal)
  if (status !== 200) throw new Error(`v3/config HTTP ${status}`)
  const models = parseModelsFromConfig(body)
  return models.length > 0 ? models : product.fallbackModels.map((m) => ({ id: m.id, name: m.name }))
}
