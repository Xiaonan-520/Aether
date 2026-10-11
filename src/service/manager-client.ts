/**
 * Core-internal Extension Manager client (docs/EXTENSION_LIFECYCLE.md §5).
 *
 * The ONLY path from Core to the Manager: every method targets one hardcoded
 * Manager route — there is deliberately no generic proxy that would forward an
 * arbitrary URL or path. The manager token is injected per call and never
 * appears in responses, logs or error messages.
 *
 * Retry policy (D5): idempotent GETs retry once on network errors / 5xx;
 * lifecycle mutations (install/stop/restart/remove/upgrade) NEVER retry —
 * a retried install would either double-install or race the first attempt.
 */

/** Manager routes Core is allowed to call. Anything else is a programming error. */
export const MANAGER_ROUTES = {
  list: 'GET /api/extensions',
  get: 'GET /api/extensions/:id',
  available: 'GET /api/extensions/available',
  install: 'POST /api/extensions/install',
  stop: 'POST /api/extensions/:id/stop',
  restart: 'POST /api/extensions/:id/restart',
  remove: 'POST /api/extensions/:id/remove',
  upgrade: 'POST /api/extensions/:id/upgrade',
  registration: 'GET /api/extensions/:id/registration',
} as const

export type ManagerErrorCode =
  | 'manager_unavailable'
  | 'extension_not_found'
  | 'manager_auth_misconfigured'
  | 'manager_error'
  | 'invalid_request'

export class ManagerClientError extends Error {
  readonly code: ManagerErrorCode
  readonly status: number
  constructor(code: ManagerErrorCode, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface ManagerEndpointConfig {
  managerUrl: string
  managerToken: string
  fetchImpl?: typeof fetch
}

export interface ManagerExtensionRecord {
  extensionId: string
  version: string
  imageRepo: string
  imageTag: string
  imageDigest: string | null
  endpointUrl: string | null
  status: string
  providerIds: string[]
  error: string | null
  installedAt: number
  updatedAt: number
}

export interface InstallRequestBody {
  manifest: unknown
  image?: { repo: string; tag: string; digest?: string }
}

const TIMEOUTS = {
  read: 5_000,
  install: 180_000,
  lifecycle: 60_000,
  upgrade: 180_000,
  registration: 10_000,
} as const

export class ManagerClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: ManagerEndpointConfig) {
    this.baseUrl = opts.managerUrl.replace(/\/$/, '')
    this.token = opts.managerToken
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  // -- reads (idempotent; one retry on transport/5xx) -----------------------

  list(): Promise<{ extensions: ManagerExtensionRecord[] }> {
    return this.requestWithRetry('GET', '/api/extensions', undefined, TIMEOUTS.read) as Promise<{ extensions: ManagerExtensionRecord[] }>
  }

  get(extensionId: string): Promise<ManagerExtensionRecord> {
    return this.requestWithRetry('GET', `/api/extensions/${encodeURIComponent(extensionId)}`, undefined, TIMEOUTS.read) as Promise<ManagerExtensionRecord>
  }

  async available(): Promise<{ extensions: ManagerExtensionRecord[] }> {
    await this.requestWithRetry('GET', '/api/extensions/available', undefined, TIMEOUTS.read)
    return this.requestWithRetry('GET', '/api/extensions/available', undefined, TIMEOUTS.read) as Promise<{ extensions: ManagerExtensionRecord[] }>
  }

  /** Sealed registration package — token material, manager-internal only. */
  registrationPackage(extensionId: string): Promise<{ manifest: unknown; endpointUrl: string; token: string }> {
    return this.requestWithRetry('GET', `/api/extensions/${encodeURIComponent(extensionId)}/registration`, undefined, TIMEOUTS.registration) as Promise<{ manifest: unknown; endpointUrl: string; token: string }>
  }

  // -- mutations (never retried) --------------------------------------------

  install(body: InstallRequestBody): Promise<ManagerExtensionRecord & { endpointUrl: string }> {
    return this.request('POST', '/api/extensions/install', body, TIMEOUTS.install) as Promise<ManagerExtensionRecord & { endpointUrl: string }>
  }

  upgrade(extensionId: string, body: InstallRequestBody): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/extensions/${encodeURIComponent(extensionId)}/upgrade`, body, TIMEOUTS.upgrade) as Promise<Record<string, unknown>>
  }

  async stop(extensionId: string): Promise<void> {
    await this.request('POST', `/api/extensions/${encodeURIComponent(extensionId)}/stop`, undefined, TIMEOUTS.lifecycle)
  }

  async restart(extensionId: string): Promise<void> {
    await this.request('POST', `/api/extensions/${encodeURIComponent(extensionId)}/restart`, undefined, TIMEOUTS.lifecycle)
  }

  async remove(extensionId: string): Promise<void> {
    await this.request('POST', `/api/extensions/${encodeURIComponent(extensionId)}/remove`, undefined, TIMEOUTS.lifecycle)
  }

  // -- internals -------------------------------------------------------------

  /** GETs are idempotent → one retry on transport failure / 5xx; POSTs never. */
  private async requestWithRetry(method: string, path: string, body: unknown, timeoutMs: number, retry = true): Promise<unknown> {
    try {
      return await this.request(method, path, body, timeoutMs)
    } catch (err) {
      const retryable = retry && method === 'GET' && err instanceof ManagerClientError
        && (err.code === 'manager_unavailable' || (err.code === 'manager_error' && err.status >= 500))
      if (retryable) return this.requestWithRetry(method, path, body, timeoutMs, false)
      throw err
    }
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    return this.request('POST', path, body, timeoutMs)
  }

  private async request(method: string, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      // transport failure — message contains no token material
      throw new ManagerClientError('manager_unavailable', 503,
        `extension manager unreachable: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (res.status === 401 || res.status === 403) {
      throw new ManagerClientError('manager_auth_misconfigured', 502,
        'extension manager rejected core credentials')
    }
    if (res.status === 404) {
      throw new ManagerClientError('extension_not_found', 404,
        `extension manager reports no such resource: ${path}`)
    }

    let parsed: unknown
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }

    if (!res.ok) {
      const detail = extractManagerError(parsed) ?? `manager returned http ${res.status}`
      throw new ManagerClientError('manager_error', res.status, detail)
    }
    return parsed
  }
}

function extractManagerError(parsed: unknown): string | null {
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const e = (parsed as { error: unknown }).error
    if (typeof e === 'string') return e
    if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
      return (e as { message: string }).message
    }
  }
  return null
}
