/**
 * Phase 3 Extension Protocol wire types (local implementation).
 *
 * Mirrors the contract the Gateway Core validates and consumes. camelCase on the
 * wire. Credential material, upstream ids and raw provider quota have no field
 * here by construction.
 */

export const PROTOCOL_VERSION = '1.0' as const
export const EXTENSION_ID = 'workbuddy'
export const PROVIDER_ID = 'workbuddy'

// ── account status (core/types.ts AccountStatus + `pending`) ──────────────
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
  | 'pending'

export const ACCOUNT_STATUSES: readonly AccountStatus[] = [
  'active', 'healthy_low_quota', 'rate_limited', 'token_expired', 'auth_failed',
  'quota_exhausted', 'cooldown', 'disabled', 'needs_manual_action', 'pending',
]

// ── quota (§13) ───────────────────────────────────────────────────────────
export type QuotaResourceKind = 'credits' | 'tokens' | 'requests' | 'subscription' | 'custom'
export type QuotaResourceStatus = 'ok' | 'low' | 'exhausted' | 'reset_pending' | 'unclaimable' | 'unknown'

export interface QuotaResource {
  id: string
  kind: QuotaResourceKind
  remaining: number | null
  total: number | null
  used: number | null
  unit: string
  resetAt: string | null
  status: QuotaResourceStatus
  metadata?: Record<string, unknown>
}

export interface QuotaSnapshotV1 {
  accountId: string
  resources: QuotaResource[]
  checkedAt: string
  source: 'authoritative' | 'cached' | 'estimate'
}

// ── account projection (§10.1) ─────────────────────────────────────────────
export type ManualActionKind = 'captcha' | 'sms' | 'relogin' | 'local_resource' | 'other'

export interface ManualActionDescriptor {
  kind: ManualActionKind
  instructions: string
  actions: Array<{ actionId: string; label: string; method: 'GET' | 'POST' }>
}

export interface ExtensionAccount {
  accountId: string
  providerId: string
  displayName: string | null
  status: AccountStatus
  manualAction: ManualActionDescriptor | null
  quota: QuotaSnapshotV1 | null
  lastError: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  metadata: Record<string, unknown>
}

export interface AccountListResponse {
  accounts: ExtensionAccount[]
}

// ── account lifecycle ─────────────────────────────────────────────────────
export type AccountLoginMode =
  | 'oauth' | 'device-code' | 'external-link' | 'sms' | 'disk-credential' | 'import'

export interface CreateAccountRequest {
  accountId?: string
  loginMode: AccountLoginMode
  displayName?: string
  phone?: string
}

export interface CreateAccountResponse {
  accountId: string
  status: 'pending'
  authorizationUrl: string | null
  expiresIn: number | null
  pollInterval: number | null
}

export interface AccountDetailResponse {
  account: ExtensionAccount
}

export interface AccountRefreshResponse {
  status: AccountStatus
  refreshed: boolean
  error: string | null
}

export interface AccountEnabledResponse {
  accountId: string
  accepted: boolean
  status: AccountStatus
}

// ── models (§9) ────────────────────────────────────────────────────────────
export interface ProtocolModelInfo {
  id: string
  name: string
  capabilities: {
    vision: boolean
    toolCall: boolean
    streaming: boolean
    reasoningEfforts?: string[]
  }
}

export interface ModelListResponse {
  models: ProtocolModelInfo[]
}

// ── chat (§11) ─────────────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
  tool_call_id?: string
  tool_calls?: unknown
  reasoning_content?: unknown
  name?: string
}

export interface Tool {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface ChatRequest {
  messages: ChatMessage[]
  model: string
  stream: boolean
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string
  tools?: Tool[]
}

/** Body of POST /v1/chat. Core supplies accountId/requestId/deadlineMs. */
export interface ExtensionChatRequest extends ChatRequest {
  accountId: string
  model: string
  requestId: string
  deadlineMs: number
}

export interface ChatChunk {
  text: string
  reasoning?: string
  finishReason?: 'stop' | 'length' | 'tool_calls' | null
  usage?: { promptTokens?: number; completionTokens?: number }
  toolCalls?: Array<{ id?: string; name?: string; arguments?: string }>
}

export interface ChatResult {
  content: string
  reasoning?: string
  finishReason: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

// ── actions (§16) ──────────────────────────────────────────────────────────
export interface InvokeActionRequest {
  actionId: string
  accountId?: string
  payload?: unknown
}

export interface InvokeActionResponse {
  actionId: string
  result: unknown
}

// ── manifest (§12) ─────────────────────────────────────────────────────────
export type ActionMode = 'read' | 'write' | 'flow-control'
export type ActionSideEffects = 'none' | 'idempotent' | 'one-shot'
export type ActionUi = 'form' | 'browser' | 'none'

export interface ActionDeclaration {
  id: string
  httpMethod: 'GET' | 'POST'
  title: string
  mode: ActionMode
  sideEffects: ActionSideEffects
  ui: ActionUi
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
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
  loginMode: AccountLoginMode
  protocol: string
}

export interface ProviderModelDeclaration {
  id: string
  name: string
  capabilities?: {
    vision?: boolean
    toolCall?: boolean
    streaming?: boolean
    reasoningEfforts?: string[]
  }
}

export interface ProviderManifestEntry {
  id: string
  displayName: string
  protocol: string
  capabilities: ProviderCapabilities
  /** Declarative quota contract (§13.1) — mirrors the Core-side type. */
  quotaResources?: Array<{
    id: string
    kind: 'credits' | 'tokens' | 'requests' | 'subscription' | 'custom'
    unit?: string
    displayName?: string
    fields?: { remaining?: boolean; total?: boolean; used?: boolean; resetAt?: boolean }
  }>
  fallbackModels?: ProviderModelDeclaration[]
  actions?: ActionDeclaration[]
  authAction?: string
  accountFields?: Array<{ name: string; required: boolean; description?: string }>
}

export interface ExtensionRuntime {
  port: number
  healthPath: string
  env?: Array<{ name: string; required: boolean; default?: string }>
  volumes?: Array<{ name: string; mountPath: string; purpose?: string }>
  resources?: { memory?: string; cpus?: string }
}

export interface ExtensionManifest {
  apiVersion: string
  extension: {
    id: string
    version: string
    displayName: string
    description?: string
    author?: string
    license?: string
    repository?: string
  }
  distribution?: { image: string; tag: string; digest?: string; releaseUrl?: string }
  runtime: ExtensionRuntime
  security?: {
    permissions?: {
      network?: { domains: string[] }
      filesystem?: 'named-volumes-only'
      capabilities?: string[]
      privileged?: boolean
    }
    secrets?: Array<{ name: string; description?: string; required: boolean }>
  }
  providers: ProviderManifestEntry[]
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  version?: string
  accounts?: { total: number; usable: number }
  message?: string
}
