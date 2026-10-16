/**
 * WorkBuddy authentication: the polling login flow (external-link) and token
 * refresh. Mirrors the upstream `buddy` China provider (fetchAuthState →
 * loopGetToken → getAccount, plus refreshToken). All credential material stays
 * inside the provider.
 *
 * Session-driven: `pollLoginOnce` advances the upstream login by exactly one
 * step and is invoked by the provider facade on each `GET /v1/accounts/:id`.
 * There is no background loop.
 */
import { errors } from '../../protocol/errors.js'
import type { Store, Credential } from '../../storage/store.js'
import type { UpstreamClient } from './client.js'
import {
  buildCredential,
  credentialExpiresAtMs,
  parseAccountData,
  parseTokenData,
  isRefreshable,
} from './parsing.js'
import {
  CODE_ACCOUNT_NOT_READY,
  CODE_TOKEN_NOT_READY,
  PLATFORM,
} from './paths.js'

export interface AuthState {
  state: string
  authorizationUrl: string
  accountId: string
  startedAt: number
}

export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
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

function responseData(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  const data = (body as Record<string, unknown>).data
  return data === null || data === undefined ? undefined : data
}

/**
 * Start a login: fetch a fresh auth state + official browser URL for an account,
 * persist the opaque state, and return the URL. No credential is involved yet.
 */
export async function startLogin(
  client: UpstreamClient,
  store: Store,
  accountId: string,
  platform: string = PLATFORM,
): Promise<AuthState> {
  const { state, authUrl } = await client.authState(platform)
  store.setAccountLoginMeta(accountId, state, authUrl)
  return { state, authorizationUrl: authUrl, accountId, startedAt: Date.now() }
}

export type PollOutcome =
  | { phase: 'pending' }
  | { phase: 'success'; expiresAt: number; displayName?: string }

/**
 * Advance the login by one upstream poll. Returns `pending` while the user has
 * not completed the official login, or `success` once the credential is stored.
 * Network/timeout errors keep the session `pending` (the user may still be
 * logging in); auth-terminal upstream errors throw.
 */
export async function pollLoginOnce(
  client: UpstreamClient,
  store: Store,
  accountId: string,
  state: string,
): Promise<PollOutcome> {
  const tokenData = await pollTokenOnce(client, state)
  if (tokenData === null) return { phase: 'pending' }
  const token = parseTokenData(tokenData)

  const accountData = await pollAccountOnce(client, state, token)
  if (accountData === null) return { phase: 'pending' }
  const account = parseAccountData(accountData)

  const credential = buildCredential(token, account)
  store.saveCredential(accountId, credential)
  const displayName = credential.nickname.length > 0 ? credential.nickname : undefined
  return { phase: 'success', expiresAt: credentialExpiresAtMs(credential) ?? 0, displayName }
}

async function pollTokenOnce(client: UpstreamClient, state: string): Promise<unknown | null> {
  let result
  try {
    result = await client.pollToken(state)
  } catch {
    // Network/timeout: keep waiting.
    return null
  }
  const { status, body } = result
  if (status === 200) {
    const data = responseData(body)
    return data ?? null
  }
  const code = responseCode(body)
  if (code === CODE_TOKEN_NOT_READY) return null
  if (status === 401 || status === 403) throw errors.authInvalid('login rejected by upstream')
  if (status === 429) throw errors.rateLimit('login polling rate limited')
  if (status >= 500) return null
  throw errors.terminal(`auth/token HTTP ${status}`)
}

async function pollAccountOnce(
  client: UpstreamClient,
  state: string,
  token: ReturnType<typeof parseTokenData>,
): Promise<unknown | null> {
  let result
  try {
    result = await client.pollAccount(state, token)
  } catch {
    return null
  }
  const { status, body } = result
  if (status === 200) {
    const data = responseData(body)
    return data ?? null
  }
  const code = responseCode(body)
  if (code === CODE_ACCOUNT_NOT_READY) return null
  if (status === 401 || status === 403) throw errors.authInvalid('login account rejected by upstream')
  if (status === 429) throw errors.rateLimit('login account polling rate limited')
  if (status >= 500) return null
  throw errors.terminal(`login/account HTTP ${status}`)
}

/**
 * Refresh an account's credential. Returns the new expiry. Throws
 * RefreshTokenExpiredError when the refresh token is terminal-invalid.
 */
export async function refreshCredential(
  client: UpstreamClient,
  store: Store,
  accountId: string,
): Promise<number> {
  const credential = store.getCredential(accountId)
  if (!credential) throw errors.authInvalid('no credential stored for account')
  if (!isRefreshable(credential)) throw errors.authInvalid('no refresh token; re-login required')

  const { status, body } = await client.refresh(credential)
  if (status !== 200) {
    const code = responseCode(body)
    const message = responseMessage(body)
    const expired = status === 401 || status === 403
      || code === 401 || code === 403
      || message.includes('expired') || message.includes('invalid')
    if (expired) throw new RefreshTokenExpiredError(message.length > 0 ? message : `HTTP ${status}`)
    if (status === 429) throw errors.rateLimit('refresh rate limited')
    if (status >= 500) throw errors.upstream5xx(`refresh HTTP ${status}`, { httpStatus: status })
    throw errors.terminal(`refresh HTTP ${status}`)
  }
  const data = responseData(body)
  if (data === undefined) throw errors.emptyResponse('refresh response missing data')
  const token = parseTokenData(data)
  const updated: Credential = {
    ...credential,
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    refresh_expires_at: token.refreshExpiresAt,
    token_type: token.tokenType.length > 0 ? token.tokenType : credential.token_type,
    scope: token.scope,
    domain: token.domain,
  }
  store.saveCredential(accountId, updated)
  store.setAccountStatus(accountId, 'active')
  return credentialExpiresAtMs(updated) ?? 0
}
