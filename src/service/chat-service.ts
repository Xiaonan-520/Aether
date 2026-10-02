/**
 * Chat orchestration: resolve model → select account → call provider →
 * normalize outcome → failover by error semantics.
 *
 * Failover rules (no blind retries):
 * - AUTH: one in-place token refresh, then one retry on the same account;
 *   after that switch account.
 * - RATE_LIMIT / QUOTA / transport-ish: switch account (exclude the failed one).
 * - TERMINAL / NEEDS_CAPTCHA / NEEDS_MANUAL: fail immediately.
 * - Once the first chunk has been emitted to the client (streaming), no more
 *   failover: the stream is aborted with the error instead.
 */
import type { Account, ChatChunk, ChatRequest, ChatResult } from '../core/types.js'
import { UpstreamError } from '../core/errors/upstream-error.js'
import { OpenAIApiError } from '../protocol/openai/parse.js'
import type { ServiceContext } from './context.js'
import { resolveCredentialJson } from './context.js'
import { AccountPool } from '../core/pool/account-pool.js'
import type { ProviderCtx } from '../core/registry/provider.js'

/** How many accounts may be tried for a single client request. */
const MAX_ACCOUNT_ATTEMPTS = 3

export interface ChatOutcome {
  kind: 'result'
  result: ChatResult
  accountId: string
  provider: string
  upstreamModel: string
}
export interface StreamOutcome {
  kind: 'stream'
  stream: AsyncGenerator<ChatChunk>
  accountId: string
  provider: string
  upstreamModel: string
}
export type ChatOrStream = ChatOutcome | StreamOutcome

export class ChatService {
  constructor(private readonly ctx: ServiceContext) {}

  private providerCtx(provider: string, account: Account): ProviderCtx {
    return {
      provider,
      resolveCredential: async (a) => {
        const credential = resolveCredentialJson<Record<string, unknown>>(this.ctx, a)
        if (!credential) return undefined
        return {
          ref: a.credentialKey,
          expiresAt: a.tokenExpiryAt,
          refreshable: a.refreshable,
          credential,
        }
      },
    }
  }

  private record(provider: string, accountId: string, kind: string, message: string, error?: UpstreamError): void {
    this.ctx.store.addEvent({
      ts: this.ctx.now(),
      level: error ? 'warn' : 'info',
      provider,
      accountId,
      kind,
      message,
    })
  }

  async handle(req: ChatRequest): Promise<ChatOrStream> {
    const resolution = this.ctx.router.resolve(
      req.model,
      true,
      (provider) => this.providerHasUsableAccount(provider),
    )
    if (!resolution) {
      throw new OpenAIApiError(404, 'invalid_request_error', `model "${req.model}" not found`)
    }
    const { entry, provider } = resolution
    const adapter = this.ctx.registry.get(provider)
    if (!adapter) {
      throw new OpenAIApiError(503, 'upstream_error', `provider "${provider}" is not installed`)
    }

    const exclude = new Set<string>()
    let refreshedAccountId: string | null = null
    let lastError: UpstreamError | undefined

    for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
      const selected = await this.ctx.pool.selectAccount(provider, {
        model: entry.upstreamModel,
        exclude,
      })
      if (!selected) break
      const account = selected.account

      try {
        const pctx = this.providerCtx(provider, account)
        if (req.stream) {
          const stream = adapter.chat.stream(pctx, req, account, req.tools)
          return {
            kind: 'stream',
            stream: this.wrappedStream(stream, provider, entry.upstreamModel, account),
            accountId: account.id,
            provider,
            upstreamModel: entry.upstreamModel,
          }
        }
        const result = await adapter.chat.chat(pctx, req, account, req.tools)
        this.ctx.pool.reportResult(account)
        this.record(provider, account.id, 'chat.success', 'chat completed')
        return {
          kind: 'result',
          result,
          accountId: account.id,
          provider,
          upstreamModel: entry.upstreamModel,
        }
      } catch (err) {
        const error = this.asUpstreamError(err, provider)
        lastError = error

        // auth problems: one in-place refresh + one same-account retry
        if (error.isAuthProblem && refreshedAccountId !== account.id) {
          refreshedAccountId = account.id
          const refreshed = await this.tryRefresh(account, provider)
          if (refreshed) {
            attempt-- // retry same account within the attempt budget
            exclude.delete(account.id)
            continue
          }
          // Terminal refresh failure parked the account in needs_manual_action;
          // skip the outer report so it isn't overwritten back to token_expired.
          this.record(provider, account.id, 'chat.fail', error.message, error)
          exclude.add(account.id)
          continue
        }

        this.ctx.pool.reportResult(account, error)
        this.record(provider, account.id, 'chat.fail', error.message, error)

        if (error.isTerminal) break
        exclude.add(account.id)
      }
    }

    throw this.toClientError(lastError)
  }

  /** Wraps a provider stream: reports success/failure, freezes failover. */
  private async *wrappedStream(
    inner: AsyncIterable<ChatChunk>,
    provider: string,
    model: string,
    account: Account,
  ): AsyncGenerator<ChatChunk> {
    let emitted = false
    try {
      for await (const chunk of inner) {
        emitted = true
        yield chunk
      }
      this.ctx.pool.reportResult(account)
      this.record(provider, account.id, 'chat.success', `stream completed (${model})`)
    } catch (err) {
      const error = this.asUpstreamError(err, provider)
      this.ctx.pool.reportResult(account, error)
      this.record(provider, account.id, 'chat.fail', error.message, error)
      // Mid-stream failure: rethrow as a terminal error; the HTTP layer has
      // already started the SSE response, so it will emit an error frame.
      throw error
    }
    void emitted
  }

  private async tryRefresh(account: Account, provider: string): Promise<boolean> {
    const adapter = this.ctx.registry.get(provider)
    if (!adapter?.ops.refreshAccount) return false
    try {
      const result = await adapter.ops.refreshAccount(this.providerCtx(provider, account), account)
      if (!result.refreshed) return false
      if (result.credential !== undefined) {
        this.ctx.store.setCredential(account.credentialKey, this.ctx.cipher.encryptJson(result.credential))
      }
      this.ctx.store.patchAccount(account.id, {
        status: 'active',
        tokenExpiryAt: result.expiresAt,
        lastError: null,
      })
      this.record(provider, account.id, 'token.refreshed', 'token refreshed during chat')
      return true
    } catch (err) {
      const error = this.asUpstreamError(err, provider)
      this.ctx.store.patchAccount(account.id, {
        status: error.isTerminal ? 'needs_manual_action' : 'auth_failed',
        lastError: error.message,
      })
      this.record(provider, account.id, 'token.refresh_failed', error.message, error)
      return false
    }
  }

  private providerHasUsableAccount(provider: string): boolean {
    // same predicate the pool selects with, so a routable account is never
    // hidden from /v1/models (e.g. rate_limited past its cooldown)
    const now = this.ctx.now()
    return this.ctx.store
      .listAccounts(provider)
      .some((s) => s.account.enabled && AccountPool.isSelectable(s.account, now))
  }

  private asUpstreamError(err: unknown, provider: string): UpstreamError {
    if (err instanceof UpstreamError) return err
    return new UpstreamError({
      kind: 'TERMINAL',
      message: err instanceof Error ? err.message : String(err),
      provider,
      cause: err,
    })
  }

  private toClientError(error: UpstreamError | undefined): OpenAIApiError {
    if (!error) {
      return new OpenAIApiError(503, 'upstream_error', 'no available account for this model')
    }
    // All-account exhaustion is a service availability problem, not a client
    // mistake: only a true business rejection maps to 400.
    const status =
      error.kind === 'RATE_LIMIT'
        ? 429
        : error.kind === 'TERMINAL'
          ? 400
          : 503
    return new OpenAIApiError(status, 'upstream_error', error.message)
  }
}
