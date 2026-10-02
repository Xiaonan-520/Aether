/**
 * ZCode (Z.AI) authentication.
 *
 * Two credential shapes are supported, matching the legitimate client flows:
 *
 * 1. OAuth (CLI flow): `POST /api/v1/oauth/cli/init` → user authorises in a
 *    browser → `GET /api/v1/oauth/cli/poll/{flowId}` returns an access token
 *    plus the long-lived `zcodejwttoken` (coding-plan credential).
 * 2. Credential import: an already-logged-in official client credential is
 *    supplied by the operator (no disk scraping, no secrets taken from other
 *    running services).
 *
 * Auth precedence at request time mirrors the reference bridge: the
 * `zcodejwttoken` (coding plan) is preferred, with the API key as fallback.
 */

export const ZCODE_API_BASE = 'https://zcode.z.ai/api/v1'

/** Upstream Anthropic Messages endpoints. */
export const ZCODE_UPSTREAM = {
  /** coding-plan endpoint authenticated with the zcodejwttoken */
  codingPlan: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',
  /** classic API-key endpoint (no trial quota) */
  apiKey: 'https://api.z.ai/api/anthropic/v1/messages',
} as const

export const ZCODE_QUOTA = {
  billing: `${ZCODE_API_BASE}/zcode-plan/billing/current`,
  balance: `${ZCODE_API_BASE}/zcode-plan/billing/balance`,
  usage: `${ZCODE_API_BASE}/zcode-plan/usage`,
} as const

/** Credential persisted (encrypted) for a ZCode account. */
export interface ZCodeCredential {
  /** long-lived coding-plan JWT; may be absent when only an API key exists */
  jwt_token?: string
  /** `apiKey.secretKey` — the Z.AI API key fallback */
  api_key?: string
  /** short-lived OAuth access token (≈1h); informational */
  oauth_access_token?: string
  /** OAuth refresh token, when the flow returned one */
  oauth_refresh_token?: string
  /** OAuth access-token expiry (ms) */
  oauth_expires_at?: number
  /** display name / account label discovered during login */
  nickname?: string
}

export function hasUsableCredential(credential: ZCodeCredential | undefined): boolean {
  if (!credential) return false
  return Boolean(credential.jwt_token) || Boolean(credential.api_key)
}

/** Which auth header to use, following the reference precedence. */
export function authHeaders(credential: ZCodeCredential): Record<string, string> {
  if (credential.jwt_token) return { Authorization: `Bearer ${credential.jwt_token}` }
  if (credential.api_key) return { 'x-api-key': credential.api_key }
  throw new Error('zcode: no usable credential (jwt_token or api_key required)')
}

/** Which upstream endpoint matches the chosen auth mode. */
export function upstreamFor(credential: ZCodeCredential): string {
  return credential.jwt_token ? ZCODE_UPSTREAM.codingPlan : ZCODE_UPSTREAM.apiKey
}

export type Fetcher = typeof fetch

// ---------------------------------------------------------------------------
// OAuth CLI flow
// ---------------------------------------------------------------------------

export interface ZCodeLoginStart {
  flowId: string
  authorizeUrl: string
  /** opaque per-flow secret echoed back on poll (never shown to clients) */
  pollToken: string
  /** server-imposed flow deadline (unix ms), when init reported one */
  expiresAt?: number
  /** server-recommended poll interval (s), when init reported one */
  pollInterval?: number
}

export function randomPollToken(): string {
  // 32 random bytes, hex — same shape as the reference implementation.
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** `POST /oauth/cli/init` → flow id + authorize URL. */
export async function startOAuth(
  pollToken: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<ZCodeLoginStart> {
  const response = await fetcher(`${ZCODE_API_BASE}/oauth/cli/init`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pollToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'zai' }),
    signal,
  })
  if (!response.ok) throw new Error(`zcode oauth init HTTP ${response.status}`)
  const json = (await response.json()) as Record<string, unknown>
  const data = (json.data ?? {}) as Record<string, unknown>
  const flowId = typeof data.flow_id === 'string' ? data.flow_id : ''
  const authorizeUrl = typeof data.authorize_url === 'string' ? data.authorize_url : ''
  if (!flowId || !authorizeUrl) throw new Error('zcode oauth init returned incomplete flow data')
  // Optional server-side flow metadata (mirrors the reference client): the
  // deadline caps how long polling may continue, the interval spaces polls.
  const expiresAt = typeof data.expires_at === 'number' && data.expires_at > 0
    ? data.expires_at * 1000
    : undefined
  const pollInterval = typeof data.poll_interval_sec === 'number' && data.poll_interval_sec > 0
    ? data.poll_interval_sec
    : undefined
  return { flowId, authorizeUrl, pollToken, expiresAt, pollInterval }
}

export interface ZCodePollResult {
  ready: boolean
  /** coding-plan JWT (`zcodejwttoken`), present when ready */
  jwtToken?: string
  /** short-lived OAuth access token, present when ready */
  accessToken?: string
  nickname?: string
}

/** `GET /oauth/cli/poll/{flowId}` — one poll. */
/** Raised when the OAuth poll is rate limited; the caller may retry after a delay. */
export class ZCodePollRateLimitedError extends Error {
  readonly status = 429
  readonly retryAfterMs: number
  constructor(retryAfterMs: number) {
    super(`zcode oauth poll rate limited; retry after ${retryAfterMs}ms`)
    this.name = 'ZCodePollRateLimitedError'
    this.retryAfterMs = retryAfterMs
  }
}

export interface ZCodePollOptions {
  /** max transient-failure retries: 429 / 408 / 5xx / network (default 3) */
  maxRetries?: number
  /** base backoff in ms (default 1000); doubles per attempt */
  baseBackoffMs?: number
  /** injected sleep so tests do not wait in real time */
  sleep?: (ms: number) => Promise<void>
}

export async function pollOAuth(
  flowId: string,
  pollToken: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  options: ZCodePollOptions = {},
): Promise<ZCodePollResult> {
  const maxRetries = options.maxRetries ?? 3
  const baseBackoffMs = options.baseBackoffMs ?? 1_000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const url = `${ZCODE_API_BASE}/oauth/cli/poll/${encodeURIComponent(flowId)}`

  /** Poll error semantics mirror the reference client: 408/429/5xx and
   *  network errors are transient (retry with backoff, honouring
   *  `retry-after`); other 4xx are fatal; a malformed 200 body counts as
   *  "still pending" so the outer poll loop simply tries again. */
  let attempt = 0
  for (;;) {
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${pollToken}` },
        signal,
      })
    } catch (err) {
      // Network error: transient unless the signal was aborted.
      if (signal?.aborted) throw err
      if (attempt >= maxRetries) throw err
      await sleep(baseBackoffMs * 2 ** attempt)
      attempt += 1
      continue
    }
    const transient = response.status === 429 || response.status === 408 || response.status >= 500
    if (transient) {
      if (attempt >= maxRetries) {
        if (response.status === 429) {
          const header = Number(response.headers.get('retry-after'))
          const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : baseBackoffMs * 2 ** attempt
          throw new ZCodePollRateLimitedError(retryAfterMs)
        }
        throw new Error(`zcode oauth poll HTTP ${response.status}`)
      }
      const header = Number(response.headers.get('retry-after'))
      const waitMs = Number.isFinite(header) && header > 0 ? header * 1000 : baseBackoffMs * 2 ** attempt
      await sleep(waitMs)
      attempt += 1
      continue
    }
    if (!response.ok) throw new Error(`zcode oauth poll HTTP ${response.status}`)
    let json: Record<string, unknown>
    try {
      json = (await response.json()) as Record<string, unknown>
    } catch {
      return { ready: false }
    }
    const data = (json.data ?? {}) as Record<string, unknown>
  const status = typeof data.status === 'string' ? data.status : ''
  const token = typeof data.token === 'string' ? data.token : ''
  const accessToken = typeof data.access_token === 'string'
    ? data.access_token
    : typeof data.accessToken === 'string' ? data.accessToken : ''
  if (status === 'ready' || token || accessToken) {
    return {
      ready: true,
      jwtToken: token || undefined,
      accessToken: accessToken || undefined,
      nickname: typeof data.nickname === 'string' ? data.nickname : undefined,
    }
  }
  return { ready: false }
  }
}

/**
 * Normalize an imported credential payload.
 *
 * Accepts the fields the official client / operator can legitimately provide.
 * Nothing is read from disk or from other services.
 */
export function normalizeImportedCredential(payload: unknown): ZCodeCredential {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('zcode credential payload must be an object')
  }
  const record = payload as Record<string, unknown>
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    return undefined
  }
  const credential: ZCodeCredential = {
    jwt_token: pick('jwt_token', 'jwtToken', 'zcodejwttoken', 'zai_token'),
    api_key: pick('api_key', 'apiKey'),
    oauth_access_token: pick('oauth_access_token', 'access_token', 'accessToken'),
    oauth_refresh_token: pick('oauth_refresh_token', 'refresh_token', 'refreshToken'),
    nickname: pick('nickname'),
  }
  if (!hasUsableCredential(credential)) {
    throw new Error('zcode credential needs a jwt_token/zcodejwttoken or an api_key')
  }
  return credential
}
