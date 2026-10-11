/**
 * Account / Model / Quota contracts for the Extension Protocol (RFC v2 §9, §10, §13).
 *
 * Ownership (RFC v2 §3.5) reflected in the type shapes:
 *  - Extension-owned facts (credentials, upstream ids, OAuth sessions, raw
 *    quota) have NO field here — an extension reports only normalized
 *    projections;
 *  - Core-owned facts (cooldown, failover state, routing eligibility) have NO
 *    field here either — extensions cannot report or set them;
 *  - every account is addressed by Core's opaque globally-unique accountId.
 *
 * The one writable channel back into extensions is the explicit
 * enable/disable command (§10.4) — Core-initiated,双向确认, mirrored in
 * RemoteProviderClient below.
 *
 * NOTE on wire casing: these TypeScript interfaces are the canonical
 * in-process contract. The HTTP transport (Phase 2) serializes them to the
 * RFC's snake_case wire format (`account_id`, `input_schema`, …); the mapping
 * is mechanical and lives in the transport layer only.
 */

import type { AccountStatus, ProviderCapabilities } from '../../core/types.js'
import type { AccountId, ModelId, ProviderId } from './namespace.js'
import type { ActionDeclaration } from './manifest.js'

// ---------------------------------------------------------------------------
// Quota (§13): multi-resource snapshot. UI renders by `kind` + `unit` only.
// ---------------------------------------------------------------------------

/** Closed enum — UI switches on this, never on provider identity. */
export type QuotaResourceKind = 'credits' | 'tokens' | 'requests' | 'subscription' | 'custom'

/** Resource-level status; drives account projection (exhausted → quota_exhausted). */
export type QuotaResourceStatus =
  | 'ok' | 'low' | 'exhausted' | 'reset_pending' | 'unclaimable' | 'unknown'

export interface QuotaResource {
  /** stable id inside the extension's namespace, e.g. "gift_credits" */
  id: string
  kind: QuotaResourceKind
  remaining: number | null
  total: number | null
  used: number | null
  /** free-form semantic unit: "credits" | "tokens" | "requests" | "USD" | "CNY" | "raw" | … */
  unit: string
  /** ISO-8601 instant or null */
  resetAt: string | null
  status: QuotaResourceStatus
  /** provider-agnostic supplements (e.g. checkin streak); never secrets */
  metadata?: Record<string, unknown>
}

/**
 * Multi-resource quota snapshot reported by an extension. An extension with
 * no quota API reports `{ resources: [] }` — Core shows "unknown" instead of
 * inventing numbers (§13.2).
 */
export interface QuotaSnapshotV1 {
  accountId: AccountId
  resources: QuotaResource[]
  /** ISO-8601 instant of the measurement */
  checkedAt: string
  /** authoritative = freshly read upstream; cached/estimate = derived */
  source: 'authoritative' | 'cached' | 'estimate'
}

// ---------------------------------------------------------------------------
// Account projection (§10.1, §10.3)
// ---------------------------------------------------------------------------

/**
 * Why the account needs a human. Core renders `instructions` and the action
 * buttons mechanically — it never interprets provider-specific semantics
 * (§10.1: no `if kind === 'zcode-captcha'` anywhere in Core).
 */
export type ManualActionKind = 'captcha' | 'sms' | 'relogin' | 'local_resource' | 'other'

export interface ManualActionDescriptor {
  kind: ManualActionKind
  instructions: string
  /** MUST reference actions declared in the provider manifest (§16.4) */
  actions: Array<{
    actionId: string
    label: string
    method: 'GET' | 'POST'
  }>
}

/**
 * Normalized account projection produced by the extension. Extension-internal
 * state (credential material, upstream ids, session objects) is deliberately
 * absent — see module docblock.
 */
export interface ExtensionAccount {
  accountId: AccountId
  providerId: ProviderId
  /** display name for admin UI */
  displayName: string | null
  status: AccountStatus
  /** structured human-action request when status === 'needs_manual_action' */
  manualAction: ManualActionDescriptor | null
  /** latest quota snapshot the extension is willing to project */
  quota: QuotaSnapshotV1 | null
  /** sanitized last error for UI display (no secrets) */
  lastError: string | null
  /** ISO-8601 timestamps of the last successful / failed upstream exchange */
  lastSuccessAt: string | null
  lastFailureAt: string | null
  /** extension-defined opaque metadata (JSON-serializable, no secrets) */
  metadata: Record<string, unknown>
}

/** GET /v1/accounts response. */
export interface AccountListResponse {
  accounts: ExtensionAccount[]
}

// ---------------------------------------------------------------------------
// Account lifecycle commands (§10.2–10.4)
// ---------------------------------------------------------------------------

/** Login/bootstrap modes — the same values as the internal LoginMode enum. */
export type AccountLoginMode =
  | 'oauth' | 'device-code' | 'external-link' | 'sms' | 'disk-credential' | 'import'

/**
 * POST /v1/accounts request.
 *
 * CREDENTIAL BOUNDARY (§10.3): this body contains ONLY the login mode and
 * display information. There is deliberately no field that could carry a
 * token/password/secret — credentials reach the extension exclusively through
 * the action channel (browser → Core opaque proxy → extension) or the
 * extension's own authorization flow. Any future field that smells like a
 * credential is a contract violation.
 */
export interface CreateAccountRequest {
  /** Core-allocated account id (§3.5); extension must address the account by it */
  accountId?: AccountId
  loginMode: AccountLoginMode
  /** optional display hint; never a credential */
  displayName?: string
  /** phone number for `sms` mode; ignored by every other mode */
  phone?: string
}

export interface CreateAccountResponse {
  accountId: AccountId
  status: 'pending'
  /** for oauth/external-link: where the human authorizes */
  authorizationUrl: string | null
  expiresIn: number | null
  pollInterval: number | null
}

/** GET /v1/accounts/:id response. */
export interface AccountDetailResponse {
  account: ExtensionAccount
}

/** POST /v1/accounts/:id/refresh response. */
export interface AccountRefreshResponse {
  status: AccountStatus
  refreshed: boolean
  error: string | null
}

/** POST /v1/accounts/:id/enable|disable request (Core-initiated write path). */
export interface AccountEnabledCommand {
  enabled: boolean
}

export interface AccountEnabledResponse {
  accountId: AccountId
  /** the extension accepted the command (mirrored in its own store) */
  accepted: boolean
  status: AccountStatus
}

// ---------------------------------------------------------------------------
// Models (§9)
// ---------------------------------------------------------------------------

export interface ProtocolModelInfo {
  id: ModelId
  name: string
  capabilities: {
    vision: boolean
    toolCall: boolean
    streaming: boolean
    reasoningEfforts?: string[]
  }
}

/** GET /v1/models response (pull channel; manifest fallbackModels are the seed). */
export interface ModelListResponse {
  models: ProtocolModelInfo[]
}
