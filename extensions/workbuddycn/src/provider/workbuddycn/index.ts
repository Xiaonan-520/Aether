/**
 * WorkBuddyCN provider facade. Bridges the low-level upstream client to the
 * Phase 3 protocol shapes: account projections, session-driven login, models,
 * quota and chat. Core owns routing/cooldown/failover; this facade only reports
 * provider-side facts.
 */
import type { AppConfig } from '../../util/config.js'
import type { Logger } from '../../util/logger.js'
import type { Store, Credential, AccountRow } from '../../storage/store.js'
import type {
  AccountStatus, ChatChunk, ChatResult, CreateAccountResponse, ExtensionAccount,
  ExtensionChatRequest, ProtocolModelInfo, QuotaSnapshotV1,
} from '../../protocol/types.js'
import { UpstreamClient, type UpstreamClientOptions } from './client.js'
import { startLogin, pollLoginOnce, refreshCredential, RefreshTokenExpiredError } from './auth.js'
import { discoverModels } from './models.js'
import { fetchQuota } from './quota.js'
import { claimDailyCheckin, fetchCheckinStatus, type ClaimOutcomeV1 } from './credits.js'
import { chatNonStreaming, chatStream } from './chat.js'
import { credentialExpiresAtMs } from './parsing.js'
import { errors, ProtocolError } from '../../protocol/errors.js'

export interface ProviderOptions {
  config: AppConfig
  store: Store
  logger: Logger
  fetcher?: typeof fetch
}

export interface ChatRuntimeContext {
  accountId: string
  requestId: string
  /** Epoch ms deadline; when exceeded the exchange aborts. */
  deadlineMs: number
  signal?: AbortSignal
}

export class WorkBuddyCNProvider {
  readonly client: UpstreamClient
  private readonly store: Store
  private readonly logger: Logger
  private readonly config: AppConfig
  /**
   * Per-account refresh single-flight. Two concurrent chats can both notice an
   * expired access token; without this, both would spend the same rotating
   * refresh token and one side would lose the credential race.
   */
  private readonly refreshInFlight = new Map<string, Promise<number>>()

  constructor(opts: ProviderOptions) {
    this.store = opts.store
    this.logger = opts.logger
    this.config = opts.config
    const clientOpts: UpstreamClientOptions = {
      endpoint: opts.config.upstreamEndpoint,
      domain: opts.config.upstreamDomain,
      productCode: opts.config.productCode,
      userAgent: opts.config.userAgent,
      requestTimeoutMs: opts.config.requestTimeoutMs,
      stateRequestTimeoutMs: opts.config.stateRequestTimeoutMs,
    }
    this.client = new UpstreamClient(clientOpts, opts.fetcher)
  }

  getLogger(): Logger {
    return this.logger
  }

  /** Single-flight token refresh per account (shared by chat/quota/claim). */
  private refreshOnce(accountId: string): Promise<number> {
    const existing = this.refreshInFlight.get(accountId)
    if (existing) return existing
    const attempt = refreshCredential(this.client, this.store, accountId)
      .finally(() => this.refreshInFlight.delete(accountId))
    this.refreshInFlight.set(accountId, attempt)
    return attempt
  }

  /**
   * Refresh a near-expiry credential before an account-scoped read (quota,
   * models, claim). Quota sync must not go stale merely because no chat has
   * refreshed the access token yet; failures are left to the caller/cache path.
   */
  private async refreshIfExpired(accountId: string): Promise<void> {
    const credential = this.store.getCredential(accountId)
    if (!credential || credential.refresh_token.length === 0) return
    const expiresAt = credentialExpiresAtMs(credential)
    const needsRefresh = expiresAt === undefined || Date.now() >= expiresAt - 30_000
    if (!needsRefresh) return
    await this.refresh(accountId).catch(() => undefined)
  }

  // ── account lifecycle ───────────────────────────────────
  async createAccount(input: { accountId?: string; displayName?: string }): Promise<CreateAccountResponse> {
    const accountId = input.accountId ?? fallbackAccountId()
    this.store.createPendingAccount({
      id: accountId,
      provider_id: 'workbuddycn',
      display_name: input.displayName,
      auth_started_at: Date.now(),
    })
    let authorizationUrl: string
    try {
      const started = await startLogin(this.client, this.store, accountId)
      authorizationUrl = started.authorizationUrl
    } catch (error) {
      this.store.deleteAccount(accountId)
      throw toProtocol(error)
    }
    this.logger.info('account.create', { account_id: accountId })
    return {
      accountId,
      status: 'pending',
      authorizationUrl,
      expiresIn: this.config.loginTtlSeconds,
      pollInterval: 1,
    }
  }

  async listAccounts(): Promise<ExtensionAccount[]> {
    return this.store.listAccounts().map((row) => this.project(row))
  }

  async getAccount(accountId: string): Promise<ExtensionAccount | undefined> {
    const row = this.store.getAccount(accountId)
    if (!row) return undefined
    if (row.status === 'pending' && row.auth_state) {
      await this.advanceLogin(row)
    }
    const refreshed = this.store.getAccount(accountId) ?? row
    return this.project(refreshed)
  }

  private async advanceLogin(row: AccountRow): Promise<void> {
    const state = row.auth_state
    if (!state) return
    const startedAt = row.auth_started_at ?? Date.now()
    if (Date.now() - startedAt > this.config.loginTtlSeconds * 1000) {
      this.store.setAccountStatus(row.id, 'auth_failed', 'login timed out')
      this.store.setAccountLoginMeta(row.id, undefined, undefined)
      return
    }
    try {
      const outcome = await pollLoginOnce(this.client, this.store, row.id, state)
      if (outcome.phase === 'success') {
        this.store.setAccountStatus(row.id, 'active')
        this.store.setAccountLoginMeta(row.id, undefined, undefined)
        if (outcome.displayName) this.store.setDisplayName(row.id, outcome.displayName)
        this.logger.info('login.success', { account_id: row.id })
      }
    } catch (error) {
      const pe = toProtocol(error)
      if (pe.kind === 'AUTH_INVALID' || pe.kind === 'TERMINAL') {
        this.store.setAccountStatus(row.id, 'auth_failed', pe.message)
        this.store.setAccountLoginMeta(row.id, undefined, undefined)
        this.logger.warn('login.failed', { account_id: row.id, error_kind: pe.kind })
      }
    }
  }

  async setEnabled(accountId: string, enabled: boolean): Promise<{ accepted: boolean; status: AccountStatus }> {
    const row = this.store.getAccount(accountId)
    if (!row) throw errors.terminal(`unknown account ${accountId}`, { httpStatus: 404 })
    this.store.setAccountEnabled(accountId, enabled)
    let status: AccountStatus
    if (!enabled) {
      this.store.setAccountStatus(accountId, 'disabled')
      status = 'disabled'
    } else {
      status = row.status === 'disabled' ? 'pending' : row.status
      this.store.setAccountStatus(accountId, status)
    }
    return { accepted: true, status }
  }

  async refresh(accountId: string): Promise<{ status: AccountStatus; refreshed: boolean; error: string | null }> {
    const row = this.store.getAccount(accountId)
    if (!row) throw errors.terminal(`unknown account ${accountId}`, { httpStatus: 404 })
    const credential = this.store.getCredential(accountId)
    if (!credential) {
      this.store.setAccountStatus(accountId, 'auth_failed', 'no credential')
      return { status: 'auth_failed', refreshed: false, error: 'no credential' }
    }
    try {
      await this.refreshOnce(accountId)
      this.store.setAccountStatus(accountId, 'active')
      this.logger.info('token.refresh', { account_id: accountId, status: 'ok' })
      return { status: 'active', refreshed: true, error: null }
    } catch (error) {
      if (error instanceof RefreshTokenExpiredError) {
        this.store.setAccountStatus(accountId, 'auth_failed', 'refresh token expired')
        return { status: 'auth_failed', refreshed: false, error: 'refresh token expired' }
      }
      const pe = toProtocol(error)
      if (pe.kind === 'AUTH_INVALID') this.store.setAccountStatus(accountId, 'auth_failed', pe.message)
      return { status: pe.kind === 'AUTH_INVALID' ? 'auth_failed' : row.status, refreshed: false, error: pe.message }
    }
  }

  async deleteAccount(accountId: string): Promise<void> {
    this.store.deleteAccount(accountId)
    this.logger.info('account.delete', { account_id: accountId })
  }

  // ── models / quota ──────────────────────────────────────
  async models(accountId: string): Promise<{ models: ProtocolModelInfo[]; source: string }> {
    await this.refreshIfExpired(accountId)
    const discovered = await discoverModels(this.client, this.store, accountId)
    return { models: discovered.models, source: discovered.source }
  }

  async quota(accountId: string, preferCache = false): Promise<QuotaSnapshotV1> {
    await this.refreshIfExpired(accountId)
    return fetchQuota(this.client, this.store, accountId, preferCache)
  }

  /**
   * Daily check-in credit claim, guarded by the authoritative activity status.
   * Only an affirmative upstream response yields `success`; an inactive or
   * already-claimed day short-circuits before the claim call. ProtocolErrors
   * (network/timeout/auth) propagate — the router maps them to protocol kinds,
   * Core decides the account-state impact.
   */
  async claim(accountId: string): Promise<ClaimOutcomeV1> {
    const row = this.store.getAccount(accountId)
    if (!row) throw errors.terminal(`unknown account ${accountId}`, { responseStatus: 404 })
    const credential = this.store.getCredential(accountId)
    if (!credential) {
      return { kind: 'needs_auth', message: 'no credential stored for this account' }
    }
    await this.refreshIfExpired(accountId)
    const fresh = this.store.getCredential(accountId) ?? credential
    const status = await fetchCheckinStatus(this.client, fresh)
    if (!status) {
      return { kind: 'failed', message: 'could not read check-in status' }
    }
    if (!status.active) {
      return { kind: 'not_available', message: 'check-in activity is not active' }
    }
    if (status.todayCheckedIn) {
      return { kind: 'already_claimed', message: 'already checked in today' }
    }
    return claimDailyCheckin(this.client, fresh)
  }

  // ── chat ────────────────────────────────────────────────
  async chat(req: ExtensionChatRequest, ctx: ChatRuntimeContext): Promise<ChatResult> {
    const signal = ctx.signal ?? deadlineSignal(ctx.deadlineMs)
    try {
      const started = Date.now()
      const result = await chatNonStreaming(req, this.chatDeps(), signal)
      this.logger.info('chat.success', {
        request_id: ctx.requestId, account_id: ctx.accountId, model: req.model, duration: Date.now() - started,
      })
      return result
    } catch (error) {
      throw toProtocol(error)
    }
  }

  async *chatStream(req: ExtensionChatRequest, ctx: ChatRuntimeContext): AsyncIterable<ChatChunk> {
    const signal = ctx.signal ?? deadlineSignal(ctx.deadlineMs)
    try {
      yield* chatStream(req, this.chatDeps(), signal)
    } catch (error) {
      throw toProtocol(error)
    }
  }

  private chatDeps() {
    return {
      client: this.client,
      store: this.store,
      timeoutMs: this.config.requestTimeoutMs,
      firstTokenTimeoutMs: this.config.streamFirstTokenTimeoutMs,
      chunkIdleTimeoutMs: this.config.streamChunkIdleTimeoutMs,
      resolveCredential: (accountId: string): Credential | undefined => {
        const row = this.store.getAccount(accountId)
        if (!row) return undefined
        if (!row.enabled) throw errors.authInvalid(`account ${accountId} is disabled`, { httpStatus: 409 })
        return this.store.getCredential(accountId)
      },
      ensureFresh: async (accountId: string, credential: Credential): Promise<Credential> => {
        const expiry = credentialExpiresAtMs(credential)
        const needsRefresh = (!expiry || Date.now() >= expiry - 30_000) && credential.refresh_token.length > 0
        if (!needsRefresh) {
          if (expiry && Date.now() >= expiry && credential.refresh_token.length === 0) {
            this.store.setAccountStatus(accountId, 'token_expired')
            throw errors.tokenExpired('credential expired and not refreshable')
          }
          return credential
        }
        try {
          await this.refreshOnce(accountId)
          return this.store.getCredential(accountId) ?? credential
        } catch (error) {
          if (error instanceof RefreshTokenExpiredError) {
            this.store.setAccountStatus(accountId, 'auth_failed', 'refresh token expired')
            throw errors.authInvalid('refresh token expired; re-login required')
          }
          throw toProtocol(error)
        }
      },
    }
  }

  private project(row: AccountRow): ExtensionAccount {
    const credential = this.store.getCredential(row.id)
    const metadata: Record<string, unknown> = {}
    if (credential) metadata.refreshable = credential.refresh_token.length > 0
    return {
      accountId: row.id,
      providerId: 'workbuddycn',
      displayName: row.display_name ?? row.id,
      status: row.status,
      manualAction: null,
      quota: null,
      lastError: row.last_error ?? null,
      lastSuccessAt: row.last_success_at ?? null,
      lastFailureAt: row.last_failure_at ?? null,
      metadata,
    }
  }
}

function fallbackAccountId(): string {
  return `workbuddycn-${Math.random().toString(16).slice(2, 10)}`
}

function deadlineSignal(deadlineMs: number): AbortSignal {
  const remaining = Math.max(1, deadlineMs - Date.now())
  return AbortSignal.timeout(remaining)
}

function toProtocol(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error
  if (error instanceof RefreshTokenExpiredError) return errors.authInvalid('refresh token expired')
  const message = error instanceof Error ? error.message : String(error)
  return errors.transport(message)
}
