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
    // The session may have expired or been revoked. Notify the shell so it can
    // drop the stored credential and show the sign-in screen again.
    notifyUnauthorized()
    throw new ApiError(401, 'Session expired — please sign in again')
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: { message?: string } | string; message?: string }
      if (typeof body.error === 'string') message = body.message ?? body.error
      else if (body.error?.message) message = body.error.message
      else if (body.message) message = body.message
    } catch {
      // keep default message
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Unauthorized broadcast
// ---------------------------------------------------------------------------
// Pages call the API independently, so a dead session is detected by whichever
// request runs first. A tiny subscriber list lets the shell react once.
const unauthorizedListeners = new Set<() => void>()

export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn)
  return () => unauthorizedListeners.delete(fn)
}

function notifyUnauthorized(): void {
  for (const fn of unauthorizedListeners) fn()
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
// The session token is the ONLY credential the browser holds. It is stored in
// sessionStorage (per-tab, cleared when the tab closes) and never in
// localStorage, never in a cookie, and never written to the console.

export interface AuthUser {
  id: string
  email: string
  createdAt: number
}

export interface AuthStatus {
  initialized: boolean
  user?: AuthUser
}

export interface AuthSession {
  token: string
  expiresAt: number
  user: AuthUser
}

export interface AuthMe {
  user: AuthUser | null
  staticToken: boolean
  expiresAt: number | null
}

/** Public: no credential required. */
export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status', { headers: authHeaderIfAny() })
  if (!res.ok) throw new ApiError(res.status, `Status check failed (${res.status})`)
  return (await res.json()) as AuthStatus
}

export async function registerAdmin(email: string, password: string): Promise<AuthSession> {
  return postAuth('/api/auth/register', email, password)
}

export async function loginAdmin(email: string, password: string): Promise<AuthSession> {
  return postAuth('/api/auth/login', email, password)
}

async function postAuth(path: string, email: string, password: string): Promise<AuthSession> {
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  } catch {
    throw new ApiError(0, 'Network error — the gateway is unreachable')
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as { message?: string; error?: string }
      if (body.message) message = body.message
    } catch {
      // keep default
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as AuthSession
}

/** Requires a credential; returns who the caller is. */
export async function fetchMe(): Promise<AuthMe> {
  return request<AuthMe>('/api/auth/me')
}

/** Revokes the session server-side (no-op for the static env token). */
export async function logoutAdmin(): Promise<void> {
  const token = getStoredToken()
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
  } catch {
    // Best effort: the local credential is cleared either way. A network
    // failure must not leave the user stuck on an authenticated screen.
  }
}

/**
 * Change the admin password. The server revokes every other session and
 * returns a fresh one, so the caller stays signed in on this device only.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<AuthSession> {
  let res: Response
  try {
    res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaderIfAny() },
      body: JSON.stringify({ currentPassword, newPassword }),
    })
  } catch {
    throw new ApiError(0, 'Network error — the gateway is unreachable')
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as { message?: string; error?: string }
      if (body.message) message = body.message
    } catch {
      /* keep default */
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as AuthSession
}

function authHeaderIfAny(): Record<string, string> {
  const token = getStoredToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
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

  // -- gateway API keys (POST /api/keys family) ------------------------------

  /** The full key appears ONLY in this create response — never store it. */
  createKey: (input: { name?: string; expiresAt?: number }) =>
    request<CreatedApiKey>('/api/keys', { method: 'POST', body: JSON.stringify(input) }),

  listKeys: () => request<{ keys: ApiKeyView[] }>('/api/keys'),

  revokeKey: (id: string) =>
    request<{ ok: boolean }>(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/** Redacted key metadata — the core never sends the key or its hash here. */
export interface ApiKeyView {
  id: string
  name: string
  keyPrefix: string
  enabled: boolean
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
  /** Admin email that created the key; null for legacy/static-token keys. */
  createdBy: string | null
}

/** Create response: the one-and-only time the full key leaves the core. */
export interface CreatedApiKey extends ApiKeyView {
  key: string
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

  /**
   * Install by image name only. The core probes the image for its manifest,
   * so the operator never handles manifest JSON (KI-001).
   */
  installFromImage: (image: { repo: string; tag: string; digest?: string }) =>
    lifecycle<{ extensionId: string; status: string; providers?: Array<{ id: string; displayName: string }> }>(
      '/api/console/extensions/install-from-image',
      { method: 'POST', body: JSON.stringify({ image }) },
    ),

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
