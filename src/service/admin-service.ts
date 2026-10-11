/**
 * Admin operations: account CRUD with encrypted credential import, manual
 * refresh/quota/claim triggers, jobs and events queries. HTTP layer exposes
 * these under /api/* behind the admin token.
 */
import { randomBytes } from 'node:crypto'
import type { Account, AccountPatch } from '../core/types.js'
import { OpenAIApiError } from '../protocol/openai/parse.js'
import type { ServiceContext } from './context.js'
import { resolveCredentialJson, storeCredentialJson } from './context.js'
import { dayKey } from '../store/memory-store.js'

/** Never expose secrets or full credential blobs through the admin API. */
function redactAccount(account: Account): Record<string, unknown> {
  return { ...account, credentialKey: `redacted(${account.credentialKey.length})` }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

export class AdminService {
  constructor(private readonly ctx: ServiceContext) {}

  listAccounts(provider?: string): Record<string, unknown>[] {
    return this.ctx.store.listAccounts(provider).map((s) => redactAccount(s.account))
  }

  getAccount(id: string): Record<string, unknown> {
    const stored = this.requireAccount(id)
    return redactAccount(stored.account)
  }

  async createAccount(input: {
    provider: string
    displayName?: string
    credential?: unknown
    providerMetadata?: Record<string, unknown>
  }): Promise<Record<string, unknown>> {
    if (!this.ctx.registry.get(input.provider)) {
      throw new OpenAIApiError(400, 'invalid_request_error', `unknown provider "${input.provider}"`)
    }
    const now = this.ctx.now()
    const id = `${input.provider}-${randomBytes(4).toString('hex')}`
    const account: Account = {
      id,
      provider: input.provider,
      displayName: input.displayName ?? id,
      status: input.credential ? 'active' : 'needs_manual_action',
      enabled: true,
      authenticated: Boolean(input.credential),
      tokenExpiryAt: null,
      refreshable: this.ctx.registry.get(input.provider)?.capabilities.supportsRefreshToken ?? false,
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
      providerMetadataJson: input.providerMetadata ? JSON.stringify(input.providerMetadata) : null,
      createdAt: now,
      updatedAt: now,
    }
    const result = this.ctx.store.createAccount(account)
    if (!result.ok) throw new OpenAIApiError(409, 'invalid_request_error', result.error)
    if (input.credential) storeCredentialJson(this.ctx, account, input.credential)
    this.ctx.store.addEvent({
      ts: now, level: 'info', provider: input.provider, accountId: id,
      kind: 'account.created', message: `account ${id} created`,
    })
    return redactAccount(account)
  }

  patchAccount(id: string, patch: AccountPatch): Record<string, unknown> {
    this.requireAccount(id)
    const result = this.ctx.store.patchAccount(id, { ...patch, updatedAt: this.ctx.now() })
    if (!result.ok) throw new OpenAIApiError(404, 'invalid_request_error', result.error)
    return redactAccount(this.requireAccount(id).account)
  }

  removeAccount(id: string): void {
    const stored = this.requireAccount(id)
    const result = this.ctx.store.removeAccount(id)
    if (!result.ok) throw new OpenAIApiError(404, 'invalid_request_error', result.error)
    this.ctx.store.deleteCredential(stored.account.credentialKey)
  }

  /** Import/replace a credential payload (import / disk-credential providers). */
  importCredential(id: string, credential: unknown, expiresAt?: number | null): Record<string, unknown> {
    const stored = this.requireAccount(id)
    storeCredentialJson(this.ctx, stored.account, credential)
    this.ctx.store.patchAccount(id, {
      authenticated: true,
      status: 'active',
      tokenExpiryAt: expiresAt ?? stored.account.tokenExpiryAt,
      updatedAt: this.ctx.now(),
    })
    this.ctx.store.addEvent({
      ts: this.ctx.now(), level: 'info', provider: stored.account.provider, accountId: id,
      kind: 'credential.imported', message: `credential imported for ${id}`,
    })
    return redactAccount(this.requireAccount(id).account)
  }

  /** Peek decrypted credential fields (admin-only; never logged). */
  inspectCredential(id: string): Record<string, unknown> | undefined {
    const stored = this.requireAccount(id)
    return resolveCredentialJson<Record<string, unknown>>(this.ctx, stored.account)
  }

  listJobs(jobType?: string): unknown[] {
    return this.ctx.store.listJobs(jobType)
  }

  /**
   * Enqueue one manual scheduler job for an account via the admin API. The
   * job goes through the same queue, concurrency limits and idempotency as
   * the recurring schedule — the console never runs adapter code directly.
   */
  enqueueAccountJob(
    ctx: ServiceContext,
    accountId: string,
    jobType: 'token_refresh' | 'quota_sync' | 'credit_claim',
  ): { jobId: string; accountId: string; jobType: string } {
    const stored = this.requireAccount(accountId)
    if (!stored.account.enabled) {
      throw new OpenAIApiError(409, 'invalid_request_error', `account "${accountId}" is disabled`)
    }
    if (jobType === 'credit_claim' && !ctx.registry.get(stored.account.provider)?.capabilities.supportsCredits) {
      throw new OpenAIApiError(400, 'invalid_request_error',
        `provider "${stored.account.provider}" does not declare supportsCredits`)
    }
    const jobId = ctx.scheduler.enqueue(jobType, accountId, stored.account.provider)
    this.ctx.store.addEvent({
      ts: this.ctx.now(), level: 'info', provider: stored.account.provider, accountId,
      kind: `job.enqueued`, message: `${jobType} enqueued for ${accountId} via admin API`,
    })
    return { jobId, accountId, jobType }
  }

  listEvents(limit: number): Record<string, unknown>[] {
    return this.ctx.store.listEvents(Math.min(Math.max(limit, 1), 500))
  }

  /**
   * Read-only claim history for one account: recent scheduler jobs of type
   * `credit_claim` plus today's recorded outcome (if any). Read only — the
   * trigger is POST /api/accounts/:id/credit-claim.
   */
  accountClaims(ctx: ServiceContext, accountId: string): Record<string, unknown>[] {
    const stored = this.requireAccount(accountId)
    const jobs = ctx.store
      .listJobs('credit_claim')
      .filter((j) => j.accountId === accountId)
      .slice(-20)
      .reverse()
    const today = dayKey(ctx.now())
    const todayOutcome = ctx.store.lastClaimOutcome(accountId, 'credit_claim', today)
    return jobs.map((j) => ({
      jobId: j.id,
      status: j.status,
      scheduledAt: j.scheduledAt,
      finishedAt: j.finishedAt,
      error: j.error,
      result: j.resultJson ? (safeParse(j.resultJson) ?? j.resultJson) : null,
      ...(j === jobs[0] && todayOutcome ? { todayOutcome } : {}),
    }))
  }

  private requireAccount(id: string) {
    const stored = this.ctx.store.getAccount(id)
    if (!stored) throw new OpenAIApiError(404, 'invalid_request_error', `account "${id}" not found`)
    return stored
  }
}
