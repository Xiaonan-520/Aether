/**
 * Account login sessions (Phase 3B).
 *
 * Exposes the provider `auth.beginLogin` / `auth.pollLogin` seam over HTTP:
 * begin creates a pending account and returns the authorization URL plus a
 * login id; poll drives the provider flow and, on success, encrypts the
 * credential into the store, flips the account to active and syncs models.
 *
 * Secrets never leave this layer: poll responses never include the credential.
 */
import type { Account, ModelEntry } from '../core/types.js'
import { OpenAIApiError } from '../protocol/openai/parse.js'
import type { ProviderCtx } from '../core/registry/provider.js'
import type { ServiceContext } from './context.js'
import { resolveCredentialJson, storeCredentialJson } from './context.js'

export interface LoginBeginResult {
  login_id: string
  provider: string
  status: 'pending'
  authorization_url: string
  expires_in: number | undefined
  poll_interval: number
}

export interface LoginPollResult {
  login_id: string
  provider: string
  status: 'pending' | 'success' | 'error'
  error?: string
  account?: Record<string, unknown>
  models_synced?: number
}

export class LoginService {
  constructor(private readonly ctx: ServiceContext) {}

  private providerCtx(provider: string): ProviderCtx {
    return {
      provider,
      resolveCredential: async (a) => {
        const credential = resolveCredentialJson<unknown>(this.ctx, a)
        if (!credential) return undefined
        return { ref: a.credentialKey, expiresAt: a.tokenExpiryAt, refreshable: a.refreshable, credential }
      },
    }
  }

  /** Create a pending account and start the provider login flow. */
  async begin(provider: string, displayName?: string): Promise<LoginBeginResult> {
    const adapter = this.ctx.registry.get(provider)
    if (!adapter) throw new OpenAIApiError(404, 'invalid_request_error', `unknown provider "${provider}"`)
    if (!adapter.auth.beginLogin) {
      throw new OpenAIApiError(400, 'invalid_request_error', `provider "${provider}" does not support interactive login`)
    }

    const now = this.ctx.now()
    const id = `${provider}-${Math.random().toString(16).slice(2, 10)}`
    const account: Account = {
      id,
      provider,
      displayName: displayName ?? id,
      status: 'needs_manual_action',
      enabled: true,
      authenticated: false,
      tokenExpiryAt: null,
      refreshable: adapter.capabilities.supportsRefreshToken,
      credentialKey: `CRED_${id.toUpperCase()}`,
      failureCount: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      cooldownUntil: null,
      modelRateLimits: {},
      quotaJson: null,
      lastQuotaAt: null,
      lastCreditClaimAt: null,
      quotaManualRequired: false,
      providerMetadataJson: null,
      createdAt: now,
      updatedAt: now,
    }
    const created = this.ctx.store.createAccount(account)
    if (!created.ok) throw new OpenAIApiError(409, 'invalid_request_error', created.error)

    try {
      const started = await adapter.auth.beginLogin({ provider, accountId: id })
      this.ctx.store.addEvent({
        ts: now, level: 'info', provider, accountId: id, kind: 'login.started', message: `login started for ${provider}`,
      })
      return {
        login_id: id,
        provider,
        status: 'pending',
        authorization_url: started.loginUrl ?? '',
        expires_in: started.expiresIn,
        poll_interval: started.pollInterval ?? 2,
      }
    } catch (err) {
      this.ctx.store.removeAccount(id)
      throw new OpenAIApiError(502, 'api_error', `failed to start login: ${(err as Error).message}`)
    }
  }

  /** Drive one poll step; on success persist the credential and sync models. */
  async poll(provider: string, loginId: string): Promise<LoginPollResult> {
    const adapter = this.ctx.registry.get(provider)
    if (!adapter) throw new OpenAIApiError(404, 'invalid_request_error', `unknown provider "${provider}"`)
    if (!adapter.auth.pollLogin) {
      throw new OpenAIApiError(400, 'invalid_request_error', `provider "${provider}" does not support login polling`)
    }
    const stored = this.ctx.store.getAccount(loginId)
    if (!stored || stored.account.provider !== provider) {
      throw new OpenAIApiError(404, 'invalid_request_error', `unknown login "${loginId}"`)
    }

    const result = await adapter.auth.pollLogin(loginId, provider)
    if (!result.done) {
      return { login_id: loginId, provider, status: 'pending' }
    }
    if (!result.success) {
      stored.account.status = 'needs_manual_action'
      this.ctx.store.patchAccount(loginId, {
        status: 'needs_manual_action',
        lastError: result.error ?? 'login failed',
        updatedAt: this.ctx.now(),
      })
      return { login_id: loginId, provider, status: 'error', error: result.error ?? 'login failed' }
    }

    const account = stored.account
    if (result.credential !== undefined) storeCredentialJson(this.ctx, account, result.credential)
    const patch = {
      authenticated: true,
      status: 'active' as const,
      tokenExpiryAt: result.expiresAt ?? null,
      lastError: null,
      ...(result.displayName ? { displayName: result.displayName } : {}),
      updatedAt: this.ctx.now(),
    }
    this.ctx.store.patchAccount(loginId, patch)
    if (result.displayName) account.displayName = result.displayName

    const modelsSynced = await this.syncModels(provider, { ...account, ...patch, authenticated: true, status: 'active' })
    this.ctx.store.addEvent({
      ts: this.ctx.now(), level: 'info', provider, accountId: loginId, kind: 'login.succeeded',
      message: `login succeeded for ${provider} (${modelsSynced} models)`,
    })
    return {
      login_id: loginId,
      provider,
      status: 'success',
      account: this.redact({ ...account, ...patch }),
      models_synced: modelsSynced,
    }
  }

  /** Pull the provider catalog into the models table for one account. */
  async syncModels(provider: string, account: Account): Promise<number> {
    const adapter = this.ctx.registry.get(provider)
    if (!adapter) return 0
    try {
      const entries: ModelEntry[] = await adapter.chat.listModels(this.providerCtx(provider), account)
      if (entries.length === 0) return 0
      this.ctx.store.upsertModels(entries)
      return entries.length
    } catch {
      return 0
    }
  }

  private redact(account: Account): Record<string, unknown> {
    return { ...account, credentialKey: `redacted(${account.credentialKey.length})` }
  }
}
