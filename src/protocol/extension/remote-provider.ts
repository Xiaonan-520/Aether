/**
 * Remote Provider abstraction (RFC v2 §24.5 "双轨兼容").
 *
 * Lets Core's business logic keep speaking the EXISTING `Provider` interface
 * while the adapter behind it is a remote extension speaking the Extension
 * Protocol over HTTP. The conversion lives entirely in this file:
 *
 *   Core business logic (pool/chat-service/scheduler)
 *        ↓  Provider interface            ← unchanged seam
 *   RemoteProvider (this file)   OR  local adapters (src/providers/*)
 *        ↓  Extension Protocol (HTTP)
 *   extension container
 *
 * Phase 1 ships the abstraction + client with a pluggable `fetch` (no
 * networking is exercised by Core itself — tests inject stubs). Nothing here
 * ever sees credential plaintext: the protocol addresses accounts by
 * Core-allocated opaque ids, and there is no `resolveCredential` on the
 * remote path (the extension holds credentials in its own store).
 */

import type {
  Account,
  ChatChunk,
  ChatRequest,
  ClaimOutcome,
  ModelEntry,
  QuotaSnapshot,
  Tool,
} from '../../core/types.js'
import type {
  BeginLoginInput,
  BeginLoginResult,
  ImportCredentialResult,
  PollLoginResult,
  Provider,
  ProviderCtx,
  RefreshResult,
} from '../../core/registry/provider.js'
import type { ProviderRegistry } from '../../core/registry/provider-registry.js'
import { UpstreamError } from '../../core/errors/upstream-error.js'
import { modelIdOf } from '../../core/naming.js'
import { extensionErrorToUpstreamError, type ExtensionErrorBody } from './errors.js'
import type { ExtensionManifest } from './manifest.js'
import { validateManifest } from './validate-manifest.js'
import type {
  AccountDetailResponse,
  AccountListResponse,
  AccountRefreshResponse,
  CreateAccountRequest,
  CreateAccountResponse,
  ModelListResponse,
  QuotaSnapshotV1,
} from './accounts.js'
import type { InvokeActionRequest, InvokeActionResponse } from './actions.js'
import type { ExtensionChatRequest } from './chat.js'
import type { ChatResult } from '../../core/types.js'

// ---------------------------------------------------------------------------
// HTTP client (transport only; all methods throw UpstreamError on failure)
// ---------------------------------------------------------------------------

export interface RemoteExtensionEndpoints {
  /** base URL inside the extension network, e.g. "http://ext-zcode:8080" */
  baseUrl: string
  /** bearer token issued at install time by the future Manager */
  token: string
}

export interface RemoteClientOptions {
  endpoints: RemoteExtensionEndpoints
  fetch?: typeof fetch
  /** per-call timeout for non-streaming calls (ms) */
  timeoutMs?: number
}

export class RemoteExtensionClient {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(opts: RemoteClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch
    this.baseUrl = opts.endpoints.baseUrl.replace(/\/$/, '')
    this.token = opts.endpoints.token
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      // transport-level failure: connection refused, timeout, abort
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new UpstreamError({
        kind: isTimeout ? 'TIMEOUT' : 'TRANSPORT',
        message: `extension unreachable: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    if (!res.ok) {
      throw await this.errorFromResponse(res)
    }
    return (await res.json()) as T
  }

  private async errorFromResponse(res: Response): Promise<UpstreamError> {
    let body: ExtensionErrorBody | undefined
    try {
      const parsed = (await res.json()) as unknown
      // an ExtensionErrorBody has error.kind; anything else is a violation
      if (parsed && typeof parsed === 'object' && 'error' in parsed) body = parsed as ExtensionErrorBody
    } catch {
      // non-JSON error body
    }
    if (body && typeof body.error?.kind === 'string') {
      return extensionErrorToUpstreamError(body, this.baseUrl)
    }
    return new UpstreamError({
      kind: 'TRANSPORT',
      message: `extension returned a non-protocol error body (http ${res.status})`,
    })
  }

  // -- endpoint wrappers (thin; types carry the contract) -------------------

  fetchManifest(): Promise<unknown> {
    return this.request<unknown>('GET', '/manifest')
  }

  fetchHealth(): Promise<{ status: string; accounts?: { total: number; usable: number } }> {
    return this.request('GET', '/health')
  }

  listAccounts(): Promise<AccountListResponse> {
    return this.request('GET', '/v1/accounts')
  }

  accountDetail(accountId: string): Promise<AccountDetailResponse> {
    return this.request('GET', `/v1/accounts/${encodeURIComponent(accountId)}`)
  }

  createAccount(req: CreateAccountRequest): Promise<CreateAccountResponse> {
    return this.request('POST', '/v1/accounts', req)
  }

  refreshAccount(accountId: string): Promise<AccountRefreshResponse> {
    return this.request('POST', `/v1/accounts/${encodeURIComponent(accountId)}/refresh`)
  }

  setAccountEnabled(accountId: string, enabled: boolean): Promise<{ accountId: string; accepted: boolean; status: string }> {
    return this.request('POST', `/v1/accounts/${encodeURIComponent(accountId)}/${enabled ? 'enable' : 'disable'}`, { enabled } satisfies { enabled: boolean })
  }

  accountQuota(accountId: string): Promise<QuotaSnapshotV1> {
    return this.request('GET', `/v1/accounts/${encodeURIComponent(accountId)}/quota`)
  }

  claimCredit(accountId: string): Promise<{ outcome: ClaimOutcome }> {
    return this.request('POST', `/v1/accounts/${encodeURIComponent(accountId)}/claim`)
  }

  listModels(): Promise<ModelListResponse> {
    return this.request('GET', '/v1/models')
  }

  /** Non-streaming chat (stream=false). Terminal errors arrive as non-2xx. */
  requestChat(req: ExtensionChatRequest): Promise<ChatResult> {
    return this.request<ChatResult>('POST', '/v1/chat', { ...req, stream: false }, req.deadlineMs + 30_000)
  }

  async *chatStream(req: ExtensionChatRequest): AsyncGenerator<ChatChunk> {
    // Streaming SSE over fetch; parse the three frame kinds.
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({ ...req, stream: true }),
        signal: AbortSignal.timeout(req.deadlineMs + 30_000),
      })
    } catch (err) {
      throw new UpstreamError({ kind: 'TRANSPORT', message: `extension unreachable: ${err instanceof Error ? err.message : String(err)}` })
    }
    if (!res.ok || !res.body) {
      throw await this.errorFromResponse(res)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawFrame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const chunk = this.parseStreamFrame(rawFrame)
          if (chunk) yield chunk
        }
      }
    } finally {
      // cancellation: client gone → close the upstream connection
      reader.releaseLock()
    }
  }

  private parseStreamFrame(rawFrame: string): ChatChunk | null {
    let event = 'message'
    let data = ''
    for (const line of rawFrame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!data) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new UpstreamError({ kind: 'TERMINAL', message: 'extension sent a malformed SSE frame' })
    }
    switch (event) {
      case 'chunk': {
        const c = parsed as ChatChunk
        if (typeof c?.text !== 'string') {
          throw new UpstreamError({ kind: 'TERMINAL', message: 'extension chunk frame missing text' })
        }
        return c
      }
      case 'done': {
        const d = parsed as { finishReason?: string; usage?: ChatResult['usage'] }
        const finishReason = (d.finishReason ?? 'stop') as ChatChunk['finishReason']
        return { text: '', finishReason, usage: d.usage }
      }
      case 'error':
        throw extensionErrorToUpstreamError(parsed as ExtensionErrorBody, this.baseUrl)
      default:
        // unknown event types are additive per §22 — ignore, don't fail
        return null
    }
  }

  invokeAction(req: InvokeActionRequest): Promise<InvokeActionResponse> {
    return this.request('POST', `/v1/actions/${encodeURIComponent(req.actionId)}`, {
      accountId: req.accountId,
      payload: req.payload,
    })
  }
}

// ---------------------------------------------------------------------------
// Quota conversion: protocol multi-resource → Core's legacy single snapshot
// ---------------------------------------------------------------------------

/**
 * Collapse a multi-resource protocol snapshot into the legacy single-resource
 * `QuotaSnapshot` Core routing consumes today (§13 compat path): pick the
 * scarcest non-custom resource; custom resources (cash balances etc.) never
 * gate routing. This is the ONLY place a v1 conversion decision lives, and it
 * is provider-agnostic by construction.
 */
export function quotaSnapshotV1ToLegacy(v1: QuotaSnapshotV1 | null): Pick<QuotaSnapshot, 'known' | 'remaining' | 'total' | 'resetAt'> {
  if (!v1 || v1.resources.length === 0) {
    return { known: false, remaining: null, total: null, resetAt: null }
  }
  const routable = v1.resources.filter((r) => r.kind !== 'custom' && r.remaining !== null)
  if (routable.length === 0) return { known: false, remaining: null, total: null, resetAt: null }
  const scarcest = routable.reduce((a, b) => {
    const ra = a.total !== null && a.total > 0 ? (a.remaining ?? 0) / a.total : 1
    const rb = b.total !== null && b.total > 0 ? (b.remaining ?? 0) / b.total : 1
    return ra <= rb ? a : b
  })
  return {
    known: true,
    remaining: scarcest.remaining,
    total: scarcest.total,
    resetAt: scarcest.resetAt ? Date.parse(scarcest.resetAt) : null,
  }
}

// ---------------------------------------------------------------------------
// RemoteProvider: adapt the protocol client onto the existing Provider seam
// ---------------------------------------------------------------------------

/** Everything Core needs to mount one remote extension as N providers. */
export interface RemoteProviderRegistration {
  manifest: ExtensionManifest
  endpoints: RemoteExtensionEndpoints
  fetch?: typeof fetch
}

/**
 * Validate + mount. Returns one `Provider` per `manifest.providers[]` entry,
 * ready for `ProviderRegistry.register()`. Throws `Error` (with violations)
 * when the manifest fails validation — installation-time gate, RFC §17.2
 * step 4/5.
 */
export function buildRemoteProviders(reg: RemoteProviderRegistration): Provider[] {
  const validation = validateManifest(reg.manifest)
  if (!validation.ok) {
    const detail = [...validation.errors, ...validation.violations]
      .map((v) => `${v.path}: ${v.message}`)
      .join('; ')
    throw new Error(`invalid extension manifest: ${detail}`)
  }
  const client = new RemoteExtensionClient({ endpoints: reg.endpoints, fetch: reg.fetch })
  return reg.manifest.providers.map((entry) => new RemoteProvider(entry.id, entry.displayName, entry.capabilities, entry.authAction, client))
}

/**
 * A `Provider` implementation backed by a remote extension. It satisfies the
 * exact seam Core already consumes — no Core code changes to route, pool or
 * schedule a remote provider.
 */
export class RemoteProvider implements Provider {
  id: string
  displayName: string
  capabilities: Provider['capabilities']
  auth: Provider['auth']
  ops: Provider['ops']
  chat: Provider['chat']

  constructor(
    providerId: string,
    displayName: string,
    capabilities: Provider['capabilities'],
    private readonly authActionId: string | undefined,
    private readonly client: RemoteExtensionClient,
  ) {
    this.id = providerId
    this.displayName = displayName
    this.capabilities = capabilities

    // ------------------------------------------------------------------ auth
    this.auth = {
      async beginLogin(input: BeginLoginInput): Promise<BeginLoginResult> {
        // Core allocates the account id (§3.5 account authority); the
        // extension addresses the login session by that same opaque id.
        const res = await client.createAccount({
          accountId: input.accountId,
          loginMode: capabilities.loginMode,
          phone: input.phone,
        })
        return {
          loginUrl: res.authorizationUrl ?? undefined,
          expiresIn: res.expiresIn ?? undefined,
          pollInterval: res.pollInterval ?? undefined,
          needsManual: res.status === 'pending',
        }
      },
      // Polling of a remote login is served by re-reading the account detail;
      // the extension advances its own login state machine.
      async pollLogin(accountId: string): Promise<PollLoginResult> {
        const res = await client.accountDetail(accountId)
        const a = res.account
        if (a.status === 'active') return { done: true, success: true }
        if (a.status === 'auth_failed') return { done: true, success: false, error: a.lastError ?? 'auth failed' }
        return { done: false }
      },
      async importCredential(accountId: string, _provider: string, payload: unknown): Promise<ImportCredentialResult> {
        // Credential payloads NEVER traverse the structured seam itself
        // (RFC §10.3) — this bridge forwards the payload opaquely to the
        // manifest-declared auth action, the narrow credential channel.
        if (!authActionId) {
          throw new UpstreamError({
            kind: 'TERMINAL',
            message: 'provider declares no auth action; credential import is not supported',
          })
        }
        const res = await client.invokeAction({
          actionId: authActionId,
          accountId,
          payload: { ...(payload as Record<string, unknown>), account_id: accountId },
        })
        const result = res.result as { accepted?: boolean; error?: string; display_name?: string | null }
        if (!result.accepted) {
          throw new UpstreamError({
            kind: 'AUTH_INVALID',
            message: result.error ?? 'auth code rejected by extension',
          })
        }
        // The extension persists the credential in its own volume; the
        // structured seam returns no credential material, only the outcome.
        return { expiresAt: null, refreshable: true, displayName: result.display_name ?? undefined }
      },
    }

    // ------------------------------------------------------------------- ops
    this.ops = {
      async refreshAccount(_ctx: ProviderCtx, account: Account): Promise<RefreshResult> {
        const res = await client.refreshAccount(account.id)
        return { refreshable: true, expiresAt: null, refreshed: res.refreshed, error: res.error ?? undefined }
      },
      async getQuota(_ctx: ProviderCtx, account: Account): Promise<QuotaSnapshot> {
        const v1 = await client.accountQuota(account.id)
        const legacy = quotaSnapshotV1ToLegacy(v1)
        // Preserve the full multi-resource snapshot for the Console: the legacy
        // projection only keeps the scarcest resource, while rawJson carries
        // every resource line (ids, units, statuses, metadata) for display.
        const rawJson = v1.resources.length > 0 ? JSON.stringify(v1) : null
        return { ...legacy, lastUpdatedAt: Date.now(), rawJson }
      },
      async claimCredits(_ctx: ProviderCtx, account: Account): Promise<ClaimOutcome> {
        const res = await client.claimCredit(account.id)
        return res.outcome
      },
      async healthCheck(): Promise<{ ok: boolean; error?: string }> {
        const health = await client.fetchHealth()
        return { ok: health.status === 'healthy' }
      },
    }

    // ------------------------------------------------------------------ chat
    this.chat = {
      async listModels(): Promise<ModelEntry[]> {
        const res = await client.listModels()
        return res.models.map((m) => ({
          // Public model IDs are namespaced `provider::upstream` (same rule as the
          // bootstrap fallback seeding in src/http/remote-bootstrap.ts); the raw
          // upstream id stays in upstreamModel for extension-bound requests.
          modelId: modelIdOf(providerId, m.id),
          provider: providerId,
          upstreamModel: m.id,
          name: m.name,
          capabilities: {
            vision: m.capabilities.vision,
            toolCall: m.capabilities.toolCall,
            streaming: m.capabilities.streaming,
            reasoningEfforts: m.capabilities.reasoningEfforts,
          },
          enabled: true,
          priority: 0,
          metadataJson: null,
        }))
      },
      async chat(_ctx: ProviderCtx, req: ChatRequest, account: Account, tools?: Tool[]): Promise<ChatResult> {
        const body: ExtensionChatRequest = {
          ...req,
          tools,
          accountId: account.id,
          model: req.model,
          requestId: crypto.randomUUID(),
          deadlineMs: 120_000,
        }
        const result = await client.requestChat(body)
        return result
      },
      async *stream(_ctx: ProviderCtx, req: ChatRequest, account: Account, tools?: Tool[]): AsyncIterable<ChatChunk> {
        const body: ExtensionChatRequest = {
          ...req,
          tools,
          accountId: account.id,
          model: req.model,
          requestId: crypto.randomUUID(),
          deadlineMs: 120_000,
        }
        yield* client.chatStream(body)
      },
    }
  }
}
