/**
 * Console API client. Talks ONLY to the Gateway Core management API (`/api/*`)
 * with the operator's admin token. It never sees provider credentials — the
 * core redacts them before any response leaves the server.
 */

const TOKEN_KEY = 'gw-console-admin-token'

export function getStoredToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function storeToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // private mode etc: token stays in memory only
  }
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getStoredToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  let res: Response
  try {
    res = await fetch(path, { ...init, headers })
  } catch {
    throw new ApiError(0, 'Network error — the gateway is unreachable')
  }
  if (res.status === 401) {
    throw new ApiError(401, 'Unauthorized — check the admin token')
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: { message?: string } | string }
      if (typeof body.error === 'string') message = body.error
      else if (body.error?.message) message = body.error.message
    } catch {
      // keep default message
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Wire types (mirror of the core's redacted admin shapes)
// ---------------------------------------------------------------------------

export type AccountStatus =
  | 'active'
  | 'healthy_low_quota'
  | 'rate_limited'
  | 'token_expired'
  | 'auth_failed'
  | 'quota_exhausted'
  | 'cooldown'
  | 'disabled'
  | 'needs_manual_action'

export interface Account {
  id: string
  provider: string
  displayName: string
  status: AccountStatus
  enabled: boolean
  authenticated: boolean
  tokenExpiryAt: number | null
  refreshable: boolean
  failureCount: number
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastError: string | null
  cooldownUntil: number | null
  quotaJson: string | null
  lastQuotaAt: number | null
  lastCreditClaimAt: number | null
  quotaManualRequired: boolean
  createdAt: number
  updatedAt: number
}

export interface ProviderCapabilities {
  supportsOAuth: boolean
  supportsRefreshToken: boolean
  supportsQuota: boolean
  supportsCredits: boolean
  supportsStreaming: boolean
  supportsVision: boolean
  supportsToolCall: boolean
  supportsMultipleAccounts: boolean
  needsCaptcha: boolean
  loginMode: string
  protocol: string
}

export interface QuotaResource {
  accountId: string
  accountDisplayName: string
  known: boolean
  remaining: number | null
  total: number | null
  resetAt: number | null
  lastUpdatedAt: number | null
  raw: unknown
}

export interface ClaimOutcomeView {
  kind: string
  message?: string
  credit?: number
  retryAfterMs?: number
}

export interface ConsoleProvider {
  id: string
  displayName: string
  capabilities: ProviderCapabilities
  accounts: {
    total: number
    enabled: number
    authenticated: number
    available: number
    needsAttention: number
  }
  models: { total: number; enabled: number }
  quotas: QuotaResource[]
  claim: {
    hasHistory: boolean
    lastAttemptAt: number | null
    lastOutcome: ClaimOutcomeView | null
  }
  lastQuotaAt: number | null
}

export interface ConsoleOverview {
  generatedAt: number
  totals: {
    providers: number
    accounts: number
    accountsAvailable: number
    models: number
    claimsToday: { success: number; failed: number }
  }
  providers: ConsoleProvider[]
}

export interface ConsoleModel {
  modelId: string
  upstreamModel: string
  name: string
  capabilities: { vision: boolean; toolCall: boolean; streaming: boolean }
  enabled: boolean
  priority: number
  exposedOnV1: boolean
}

export interface ClaimJob {
  id: string
  provider: string | null
  accountId: string | null
  jobType: string
  scheduledAt: number
  startedAt: number | null
  finishedAt: number | null
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  error: string | null
  resultJson: string | null
  attempts: number
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  overview: () => request<ConsoleOverview>('/api/console/overview'),

  providerModels: (id: string) =>
    request<{ models: ConsoleModel[] }>(`/api/console/providers/${encodeURIComponent(id)}/models`),

  providerClaims: (id: string) =>
    request<{ claims: ClaimJob[] }>(`/api/console/providers/${encodeURIComponent(id)}/claims`),

  accounts: (provider?: string) =>
    request<{ accounts: Account[] }>(
      `/api/accounts${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`,
    ),

  patchAccount: (id: string, patch: Record<string, unknown>) =>
    request<Account>(`/api/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  removeAccount: (id: string) =>
    request<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  beginLogin: (provider: string, displayName?: string) =>
    request<BeginLoginResult>(`/api/accounts/${encodeURIComponent(provider)}/login`, {
      method: 'POST',
      body: JSON.stringify(displayName ? { displayName } : {}),
    }),

  pollLogin: (provider: string, loginId: string) =>
    request<PollLoginResult>(
      `/api/accounts/${encodeURIComponent(provider)}/login/${encodeURIComponent(loginId)}`,
    ),

  /** Manual maintenance trigger — goes through the scheduler queue. */
  triggerJob: (accountId: string, jobType: 'refresh' | 'quota-sync') =>
    request<{ jobId: string }>(`/api/accounts/${encodeURIComponent(accountId)}/${jobType}`, {
      method: 'POST',
    }),
}

export interface BeginLoginResult {
  login_id: string
  provider: string
  status: 'pending'
  authorization_url: string
  expires_in?: number
  poll_interval?: number
}

export interface PollLoginResult {
  login_id: string
  provider: string
  status: 'pending' | 'success' | 'error'
  error?: string
  account?: Record<string, unknown>
  models_synced?: number
}

// ---------------------------------------------------------------------------
// Extension lifecycle management (docs/EXTENSION_LIFECYCLE.md §5)
// Wire shapes mirror the core's /api/console/extensions projection. The
// browser never sees the manager token — these calls hit the core only.
// ---------------------------------------------------------------------------

export type InstallState =
  | 'pending' | 'validating' | 'pulling' | 'starting' | 'health_check'
  | 'conformance' | 'registering' | 'installed' | 'stopped' | 'failed' | 'removing'

export type RuntimeState = 'running' | 'stopped' | 'unreachable' | 'unknown'
export type HealthState = 'healthy' | 'degraded' | 'unknown'

export interface ExtensionRecord {
  extensionId: string
  name: string
  version: string
  image: { repo: string; tag: string; digest: string | null }
  installState: InstallState
  runtimeState: RuntimeState
  healthState: HealthState
  /** provider ids owned by this extension (1 extension : N providers) */
  providers: string[]
  providersRegistered: boolean
  lastError: string | null
  installedAt: number
  updatedAt: number
}

export interface AvailableExtension {
  extensionId: string
  version: string
  status: string
  [key: string]: unknown
}

export interface ManifestAction {
  id: string
  httpMethod?: string
  title?: string
  description?: string
  mode?: string
  sideEffects?: string
  ui?: 'none' | 'basic' | 'page'
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  [key: string]: unknown
}

export interface ActionInvocation {
  actionId: string
  result: unknown
}

function lifecycle<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init)
}

export const extensionsApi = {
  list: () => request<{ extensions: ExtensionRecord[] }>('/api/console/extensions'),

  detail: (id: string) =>
    request<ExtensionRecord>(`/api/console/extensions/${encodeURIComponent(id)}`),

  available: () => request<{ extensions: AvailableExtension[] }>('/api/console/extensions/available'),

  install: (manifest: unknown, image?: { repo: string; tag: string; digest?: string }) =>
    lifecycle<{ extensionId: string; status: string }>('/api/console/extensions/install', {
      method: 'POST',
      body: JSON.stringify({ manifest, image }),
    }),

  upgrade: (id: string, manifest: unknown, image?: { repo: string; tag: string; digest?: string }) =>
    lifecycle<{ extensionId: string; status: string }>(
      `/api/console/extensions/${encodeURIComponent(id)}/upgrade`,
      { method: 'POST', body: JSON.stringify({ manifest, image }) },
    ),

  stop: (id: string) =>
    lifecycle<{ ok: boolean }>(`/api/console/extensions/${encodeURIComponent(id)}/stop`, { method: 'POST' }),

  restart: (id: string) =>
    lifecycle<{ ok: boolean }>(`/api/console/extensions/${encodeURIComponent(id)}/restart`, { method: 'POST' }),

  remove: (id: string) =>
    lifecycle<{ ok: boolean }>(`/api/console/extensions/${encodeURIComponent(id)}/remove`, { method: 'POST' }),

  /** re-mount the extension's providers in the core (post-upgrade token rotation) */
  reload: (id: string) =>
    lifecycle<{ ok: boolean; providers: string[] }>(
      `/api/console/extensions/${encodeURIComponent(id)}/reload`,
      { method: 'POST' },
    ),

  /** manifest-declared actions for one provider — the dynamic form descriptor */
  actions: (id: string, providerId: string) =>
    request<{ actions: ManifestAction[] }>(
      `/api/console/extensions/${encodeURIComponent(id)}/providers/${encodeURIComponent(providerId)}/actions`,
    ),

  /** opaque invocation; payload validated by the extension against inputSchema */
  invokeAction: (id: string, providerId: string, actionId: string, payload: { accountId?: string; payload?: unknown } = {}) =>
    lifecycle<ActionInvocation>(
      `/api/console/extensions/${encodeURIComponent(id)}/providers/${encodeURIComponent(providerId)}/actions/${encodeURIComponent(actionId)}`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
}

/** Error body of the new-style { error: { code, message } } shape. */
export interface ExtensionApiError {
  code: string
  message: string
}
