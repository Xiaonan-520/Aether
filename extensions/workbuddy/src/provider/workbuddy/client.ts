/**
 * Low-level HTTP client for the WorkBuddy upstream. Every request has an
 * explicit timeout, supports external cancellation, and returns a classified
 * result so the adapter can map it to ProtocolErrors. No credential is ever
 * serialized into error messages.
 */
import { errors, type ProtocolError } from '../../protocol/errors.js'
import {
  H_AUTH_REFRESH_SOURCE,
  H_DOMAIN,
  H_ENTERPRISE_ID,
  H_NO_AUTHORIZATION,
  H_NO_DEPARTMENT_INFO,
  H_NO_ENTERPRISE_ID,
  H_NO_USER_ID,
  H_PRODUCT,
  H_PRODUCT_CODE,
  H_REFRESH_TOKEN,
  H_TENANT_ID,
  H_USER_ID,
  REQUEST_TIMEOUT_MS,
  STATE_REQUEST_TIMEOUT_MS,
  AUTH_REFRESH_SOURCE,
  BUDDY_DEPLOYMENT_TYPE,
} from './paths.js'
import type { Credential } from '../../storage/store.js'

export interface HttpResponse {
  status: number
  body: unknown
  text: string
}

export interface UpstreamClientOptions {
  endpoint: string
  domain: string
  productCode: string
  userAgent: string
  fetcher?: typeof fetch
  requestTimeoutMs?: number
  stateRequestTimeoutMs?: number
}

type Fetcher = typeof fetch

export class UpstreamClient {
  private readonly fetcher: Fetcher

  constructor(
    private readonly opts: UpstreamClientOptions,
    fetcher?: typeof fetch,
  ) {
    this.fetcher = fetcher ?? globalThis.fetch.bind(globalThis)
  }

  get endpoint(): string {
    return this.opts.endpoint
  }

  get domain(): string {
    return this.opts.domain
  }

  /** Build the base headers shared by most control-plane calls. */
  private baseHeaders(): Record<string, string> {
    return {
      [H_DOMAIN]: this.opts.domain,
      'User-Agent': this.opts.userAgent,
    }
  }

  /** Build billing/chat-style headers with the account's product attribution. */
  productHeaders(credential: Credential): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.baseHeaders(),
      [H_PRODUCT]: BUDDY_DEPLOYMENT_TYPE,
      [H_PRODUCT_CODE]: this.opts.productCode,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (credential.user_id.length > 0) headers[H_USER_ID] = credential.user_id
    if (credential.enterprise_id.length > 0) {
      headers[H_ENTERPRISE_ID] = credential.enterprise_id
      headers[H_TENANT_ID] = credential.enterprise_id
    }
    return headers
  }

  private signalFor(timeoutMs: number, signal?: AbortSignal): AbortSignal {
    if (!signal) return AbortSignal.timeout(timeoutMs)
    return AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
  }

  /**
   * Perform an upstream request with timeout + optional external cancellation.
   * Returns the parsed JSON body. Throws a classified ProtocolError on failure.
   */
  async request(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    opts: { timeoutMs?: number; signal?: AbortSignal; body?: string; allowNonJson?: boolean } = {},
  ): Promise<HttpResponse> {
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    let response: Response
    try {
      response = await this.fetcher(url, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        signal: this.signalFor(timeoutMs, opts.signal),
      })
    } catch (error) {
      throw classifyNetworkError(error, opts.signal)
    }
    const raw = await response.text()
    let body: unknown = null
    try {
      body = raw.length > 0 ? (JSON.parse(raw) as unknown) : null
    } catch {
      if (!opts.allowNonJson) {
        throw errors.upstream5xx(
          `Non-JSON upstream response (HTTP ${response.status})`,
          { httpStatus: response.status },
        )
      }
    }
    return { status: response.status, body, text: raw }
  }

  // ── auth state (no auth) ──────────────────────────────────────
  async authState(platform: string): Promise<{ state: string; authUrl: string }> {
    const url = `${this.opts.endpoint}/v2/plugin/auth/state?platform=${encodeURIComponent(platform)}`
    const headers: Record<string, string> = {
      ...this.baseHeaders(),
      [H_NO_AUTHORIZATION]: 'true',
      [H_NO_USER_ID]: 'true',
      [H_NO_ENTERPRISE_ID]: 'true',
      [H_NO_DEPARTMENT_INFO]: 'true',
    }
    const { status, body } = await this.request('POST', url, headers, {
      timeoutMs: STATE_REQUEST_TIMEOUT_MS,
    })
    if (status !== 200) throw errors.transport(`auth/state HTTP ${status}`)
    const data = extractData(body)
    if (typeof data !== 'object' || data === null) throw errors.upstream5xx('auth/state missing data')
    const record = data as Record<string, unknown>
    const state = typeof record.state === 'string' ? record.state : ''
    const authUrl = typeof record.authUrl === 'string' ? record.authUrl : ''
    if (state.length === 0 || authUrl.length === 0) {
      throw errors.upstream5xx('auth/state missing state or authUrl')
    }
    return { state, authUrl }
  }

  // ── token polling ─────────────────────────────────────────────
  async pollToken(state: string): Promise<HttpResponse> {
    const url = `${this.opts.endpoint}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`
    const headers: Record<string, string> = {
      [H_NO_AUTHORIZATION]: 'true',
      'User-Agent': this.opts.userAgent,
    }
    return this.request('GET', url, headers)
  }

  // ── account polling ───────────────────────────────────────────
  async pollAccount(state: string, token: RawTokenMin): Promise<HttpResponse> {
    const url = `${this.opts.endpoint}/v2/plugin/login/account?state=${encodeURIComponent(state)}`
    const headers: Record<string, string> = {
      [H_DOMAIN]: token.domain || this.opts.domain,
      Authorization: `Bearer ${token.accessToken}`,
      [H_NO_USER_ID]: 'true',
      [H_NO_ENTERPRISE_ID]: 'true',
      'User-Agent': this.opts.userAgent,
    }
    return this.request('GET', url, headers)
  }

  // ── refresh ───────────────────────────────────────────────────
  async refresh(credential: Credential): Promise<HttpResponse> {
    const url = `${this.opts.endpoint}/v2/plugin/auth/token/refresh`
    const headers: Record<string, string> = {
      ...this.baseHeaders(),
      [H_DOMAIN]: this.opts.domain,
      Authorization: `Bearer ${credential.access_token}`,
      [H_REFRESH_TOKEN]: credential.refresh_token,
      [H_AUTH_REFRESH_SOURCE]: AUTH_REFRESH_SOURCE,
    }
    return this.request('POST', url, headers)
  }

  // ── config / models ───────────────────────────────────────────
  async fetchConfig(credential: Credential, path: '/v3/config' | string): Promise<HttpResponse> {
    const url = `${this.opts.endpoint}${path}`
    const headers: Record<string, string> = {
      ...this.baseHeaders(),
      [H_DOMAIN]: this.opts.domain,
      [H_PRODUCT]: BUDDY_DEPLOYMENT_TYPE,
      [H_PRODUCT_CODE]: this.opts.productCode,
      Authorization: `Bearer ${credential.access_token}`,
    }
    return this.request('GET', url, headers)
  }

  // ── chat completions (returns raw response for SSE consumption) ──
  async chat(
    credential: Credential,
    body: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${this.opts.endpoint}/v2/chat/completions`
    const headers: Record<string, string> = {
      ...this.productHeaders(credential),
      Authorization: `Bearer ${credential.access_token}`,
      Accept: 'text/event-stream',
      'X-Agent-Purpose': 'conversation',
      'X-IDE-Name': 'WorkBuddy',
      'X-IDE-Type': 'WorkBuddy',
      'X-IDE-Version': '5.5.2',
    }
    try {
      return await this.fetcher(url, {
        method: 'POST',
        headers,
        body,
        signal: this.signalFor(this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, signal),
      })
    } catch (error) {
      throw classifyNetworkError(error, signal)
    }
  }

  // ── billing / quota ───────────────────────────────────────────
  async postBilling(credential: Credential, path: string): Promise<HttpResponse> {
    const url = `${this.opts.endpoint}${path}`
    const headers = this.productHeaders(credential)
    headers.Authorization = `Bearer ${credential.access_token}`
    return this.request('POST', url, headers, { body: '{}' })
  }
}

export interface RawTokenMin {
  accessToken: string
  domain: string
}

function extractData(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  const data = (body as Record<string, unknown>).data
  return data === null || data === undefined ? undefined : data
}

/**
 * Classify a thrown fetch error (network / timeout / abort) into a retryable
 * ProtocolError. Credential/body content is never included.
 */
export function classifyNetworkError(error: unknown, signal?: AbortSignal): ProtocolError {
  if (signal?.aborted) {
    throw errors.transport('request cancelled locally')
  }
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  // Timeout from AbortSignal.timeout().
  if (name === 'TimeoutError' || message.includes('timeout')) {
    throw errors.timeout('upstream request timed out')
  }
  if (
    message.includes('terminated')
    || name.startsWith('UND_ERR_')
    || message.includes('fetch failed')
    || message.includes('econnreset')
    || message.includes('epipe')
    || message.includes('socket hang up')
  ) {
    throw errors.transport(`upstream network error: ${name || 'connection'}`)
  }
  throw errors.transport(`upstream request failed: ${name || 'unknown'}`)
}

export { extractData }