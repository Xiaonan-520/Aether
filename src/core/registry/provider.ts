/**
 * Provider interface (the seam between Gateway Core and provider adapters).
 *
 * Gateway Core knows ONLY: authenticate/refresh/models/chat/stream/quota/claim/health
 * plus capabilities. Every piece of provider-specific behavior (HMAC, DPoP,
 * external-link-v2, WASM encryption, Anthropic protocol, token exchange, captcha)
 * must live inside an adapter implementing this interface — never in Core.
 */

import type {
  Account,
  ChatChunk,
  ChatRequest,
  ChatResult,
  ModelEntry,
  ProviderCapabilities,
  QuotaSnapshot,
  ClaimOutcome,
  Tool,
} from '../types.js'
import type { UpstreamError } from '../errors/upstream-error.js'

/** Result of a credential resolution for one account. */
export interface CredentialHandle {
  /** opaque blob identifying the resolved secret; adapter interprets it */
  ref: string
  /** when the access token expires (ms) — may be null if unknown */
  expiresAt: number | null
  /** whether this handle can be refreshed */
  refreshable: boolean
}

export interface BeginLoginInput {
  provider: string
  accountId: string
}
export interface BeginLoginResult {
  loginUrl?: string
  deviceCode?: string
  verificationUriComplete?: string
  expiresIn?: number
  pollInterval?: number
  /** true when this provider needs human interaction (sms/captcha) to finish login */
  needsManual?: boolean
}
export interface PollLoginResult {
  done: boolean
  success?: boolean
  loginUrl?: string
  error?: string
}

export interface RefreshResult {
  refreshable: boolean
  expiresAt: number | null
  /** true if refresh was performed and credential updated */
  refreshed: boolean
  error?: string
}

export interface ProviderChatImpl {
  /** must be safe to call repeatedly (cached by callers) */
  listModels(ctx: ProviderCtx): Promise<ModelEntry[]>
  /** non-streaming convenience; adapters may implement via stream() */
  chat(
    ctx: ProviderCtx,
    req: ChatRequest,
    account: Account,
    tools?: Tool[],
  ): Promise<ChatResult>
  /** streaming; yields canonical ChatChunk */
  stream(
    ctx: ProviderCtx,
    req: ChatRequest,
    account: Account,
    tools?: Tool[],
  ): AsyncIterable<ChatChunk>
}

export interface ProviderAuthImpl {
  beginLogin?(input: BeginLoginInput): Promise<BeginLoginResult>
  pollLogin?(accountId: string, provider: string): Promise<PollLoginResult>
  /** upload a credential blob for an account (disk-credential / import modes) */
  importCredential?(accountId: string, provider: string, payload: unknown): Promise<{ expiresAt: number | null; refreshable: boolean }>
}

export interface ProviderOpsImpl {
  /** always try to refresh; throw UpstreamError('TERMINAL') if truly dead */
  refreshAccount?(
    ctx: ProviderCtx,
    account: Account,
  ): Promise<RefreshResult>
  getQuota?(ctx: ProviderCtx, account: Account): Promise<QuotaSnapshot>
  claimCredits?(ctx: ProviderCtx, account: Account): Promise<ClaimOutcome>
  /** lightweight health probe (auth validity / reachability) */
  healthCheck?(ctx: ProviderCtx, account: Account): Promise<{ ok: boolean; error?: string }>
  /** true when the upstream error is terminal for this account */
  mapError?(err: unknown): UpstreamError
}

export interface ProviderCtx {
  provider: string
  /** resolves the secret for an account (adapter interprets CredentialHandle.ref) */
  resolveCredential(account: Account): Promise<CredentialHandle | undefined>
}

/** One installed provider adapter. */
export interface Provider {
  id: string
  displayName: string
  capabilities: ProviderCapabilities
  auth: ProviderAuthImpl
  ops: ProviderOpsImpl
  chat: ProviderChatImpl
}
