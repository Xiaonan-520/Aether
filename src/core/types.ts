/**
 * Core domain types shared by Gateway Core, Service and Provider Adapters.
 *
 * The Provider/Service/Core layers do NOT import anything from the HTTP layer
 * (Hono) and do NOT depend on any concrete storage backend. They only depend
 * on these types, the `StoreGateway` abstraction (see store/) and the error
 * normalizer.
 */

// ---------------------------------------------------------------------------
// Provider capability flags (declarative; do NOT force every provider to
// implement everything). Provider-specific code must live in adapters only.
// ---------------------------------------------------------------------------
export type LoginMode =
  | 'oauth'            // browser OAuth + local callback / portal authorize
  | 'device-code'      // RFC8628-ish device code / polling
  | 'external-link'    // CodeBuddy external-link-v2 style polling
  | 'sms'              // sms verification code (human-in-the-loop)
  | 'disk-credential'  // read/decrypt credentials from local disk (ZCode)
  | 'import'           // admin imports credentials via management API

export type UpstreamProtocol = 'openai-chat' | 'anthropic-messages'

export interface ProviderCapabilities {
  supportsOAuth: boolean
  supportsRefreshToken: boolean
  supportsQuota: boolean
  /** platform itself offers a legitimate credits/checkin/claim API */
  supportsCredits: boolean
  supportsStreaming: boolean
  supportsVision: boolean
  supportsToolCall: boolean
  supportsMultipleAccounts: boolean
  /** upstream needs a captcha; gateway will NOT auto-solve it */
  needsCaptcha: boolean
  loginMode: LoginMode
  protocol: UpstreamProtocol
}

// ---------------------------------------------------------------------------
// Account model
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

export interface ModelRateLimit {
  /** upstream-reset timestamp (ms). 0 / undefined = not in reset window. */
  resetAtMs: number
}

/** A health + routing signal about a stored account. No secrets here. */
export interface Account {
  id: string
  provider: string
  displayName: string
  status: AccountStatus
  enabled: boolean
  authenticated: boolean
  /** access token expiry; undefined = unknown */
  tokenExpiryAt: number | null
  refreshable: boolean
  credentialKey: string
  failureCount: number
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastError: string | null
  cooldownUntil: number | null
  modelRateLimits: Record<string, ModelRateLimit>
  quotaJson: string | null
  lastQuotaAt: number | null
  lastCreditClaimAt: number | null
  quotaManualRequired: boolean
  providerMetadataJson: string | null
  createdAt: number
  updatedAt: number
}

export type AccountPatch = Partial<Omit<Account, 'id' | 'provider' | 'createdAt'>>

// ---------------------------------------------------------------------------
// Quota snapshot (routing signal, NOT a hard gate)
// ---------------------------------------------------------------------------
export interface QuotaSnapshot {
  known: boolean      // false = provider has no reliable quota API
  remaining: number | null
  total: number | null
  resetAt: number | null
  lastUpdatedAt: number
  /** provider-specific raw payload preserved for UI */
  rawJson: string | null
}

// ---------------------------------------------------------------------------
// Model registry entry
// ---------------------------------------------------------------------------
export interface ModelEntry {
  /** id exposed to OpenAI clients (may contain a provider prefix) */
  modelId: string
  provider: string
  /** real model id sent upstream */
  upstreamModel: string
  name: string
  capabilities: {
    vision: boolean
    toolCall: boolean
    streaming: boolean
    reasoningEfforts?: string[]
  }
  enabled: boolean
  priority: number
  metadataJson: string | null
}

// ---------------------------------------------------------------------------
// Credit claim result (normalized across providers)
// ---------------------------------------------------------------------------
export type ClaimOutcome =
  | { kind: 'success'; credit: number; message?: string }
  | { kind: 'already_claimed'; message?: string }
  | { kind: 'not_available'; message?: string }
  | { kind: 'quota_exhausted'; message?: string }
  | { kind: 'rate_limited'; message?: string; retryAfterMs?: number }
  | { kind: 'needs_auth'; message?: string }
  | { kind: 'needs_manual_action'; message?: string }
  | { kind: 'unsupported'; message?: string }
  | { kind: 'failed'; message?: string }

// ---------------------------------------------------------------------------
// Chat request/response canonical model
// ---------------------------------------------------------------------------
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
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

export interface Tool {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

/** A canonical stream chunk produced by provider adapters. */
export interface ChatChunk {
  /** partial or final text */
  text: string
  /** reasoning content (if any) */
  reasoning?: string
  /** final finish reason */
  finishReason?: 'stop' | 'length' | 'tool_calls' | null
  /** accumulated usage for final chunk */
  usage?: { promptTokens?: number; completionTokens?: number }
  /** streamed-in tool call pieces */
  toolCalls?: Array<{ id?: string; name?: string; arguments?: string }>
}

export interface ChatResult {
  content: string
  reasoning?: string
  finishReason: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

// ---------------------------------------------------------------------------
// Selected account + resolved credential handle (secret never escapes)
// ---------------------------------------------------------------------------
export interface SelectedAccount {
  account: Account
  /** opaque secret handle; adapter resolves the actual secret via its own store */
  credentialKey: string
}
