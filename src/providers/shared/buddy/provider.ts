/**
 * Shared Buddy-family provider adapter.
 *
 * One implementation serves CodeBuddy and WorkBuddy; only the product config
 * differs. The upstream chat endpoint is OpenAI-compatible, so the adapter
 * forwards an OpenAI body and maps the OpenAI SSE deltas back onto the
 * Gateway's canonical ChatChunk — no second OpenAI serializer is written here.
 */
import type {
  Account,
  ChatChunk,
  ChatRequest,
  ChatResult,
  ModelEntry,
  ProviderCapabilities,
  QuotaSnapshot,
  Tool,
  ClaimOutcome,
} from '../../../core/types.js'
import type {
  BeginLoginInput,
  BeginLoginResult,
  PollLoginResult,
  Provider,
  ProviderCtx,
  RefreshResult,
} from '../../../core/registry/provider.js'
import { UpstreamError } from '../../../core/errors/upstream-error.js'
import {
  CHAT_PATH,
} from './constants.js'
import { resolveUserAgent, type BuddyProduct } from './product.js'
import { claimDailyCheckin, fetchCheckinStatus } from './credits.js'
import {
  BuddyRefreshExpiredError,
  buildCredential,
  credentialAuthHeaders,
  credentialExpiresAtMs,
  fetchAuthState,
  fetchBuddyModels,
  isRefreshable,
  pollAccountOnce,
  pollTokenOnce,
  refreshBuddyToken,
  type BuddyCredential,
  type Fetcher,
} from './protocol.js'

/** Per-account in-flight login sessions (ephemeral by design). */
interface LoginSession {
  state: string
  authUrl: string
  startedAt: number
}

const LOGIN_TTL_MS = 5 * 60 * 1000

export function createBuddyProvider(product: BuddyProduct, fetcher: Fetcher = fetch): Provider {
  const sessions = new Map<string, LoginSession>()

  const capabilities: ProviderCapabilities = {
    supportsOAuth: true,
    supportsRefreshToken: true,
    supportsQuota: true,
    // Daily check-in verified live against this deployment's WorkBuddy account
    // (POST /v2/billing/meter/checkin-activity-status returns real data).
    supportsCredits: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsToolCall: true,
    supportsMultipleAccounts: true,
    needsCaptcha: false,
    loginMode: 'external-link',
    protocol: 'openai-chat',
  }

  /** Decrypted credential for an account (ProviderCtx carries it now). */
  async function credentialOf(ctx: ProviderCtx, account: Account): Promise<BuddyCredential | undefined> {
    const handle = await ctx.resolveCredential(account)
    return handle?.credential as BuddyCredential | undefined
  }

  /** The client may send `provider::model`; upstream wants the bare id. */
  function bareModel(model: string): string {
    const sep = model.indexOf('::')
    return sep > 0 ? model.slice(sep + 2) : model
  }

  /** Buddy upstream rejects requests whose first message is not a system prompt
   * (`code 11128`). Prepend a default only when the client sent none. */
  const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.'

  function withLeadingSystem(
    messages: ChatRequest['messages'],
  ): ChatRequest['messages'] {
    if (messages.length > 0 && messages[0].role === 'system') return messages
    return [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }, ...messages]
  }

  /**
   * Canonical ChatRequest → upstream OpenAI chat body.
   *
   * `stream` is always true: the Buddy upstream answers `code 11101`
   * ("Non-stream chat request is currently not supported") otherwise, so a
   * non-streaming client is served by aggregating the SSE stream here.
   */
  function toUpstreamBody(req: ChatRequest, upstreamModel: string): Record<string, unknown> {
    const messages = withLeadingSystem(req.messages).map((m: ChatRequest['messages'][number]) => {
      const base: Record<string, unknown> = { role: m.role, content: m.content }
      if (m.toolCalls) {
        base.tool_calls = m.toolCalls.map((tc: NonNullable<ChatRequest['messages'][number]['toolCalls']>[number]) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }))
      }
      if (m.toolCallId) base.tool_call_id = m.toolCallId
      if (m.name) base.name = m.name
      return base
    })
    const body: Record<string, unknown> = { model: upstreamModel, messages, stream: true }
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t: Tool) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters ?? {} },
      }))
    }
    return body
  }

  /** Chat headers: Bearer + product attribution family. */
  function chatHeaders(credential: BuddyCredential, model: string): Record<string, string> {
    return {
      ...credentialAuthHeaders(credential, product),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Product-Code': product.productCode,
      'X-Agent-Purpose': 'conversation',
      'X-IDE-Name': product.attributionName,
      'X-IDE-Type': product.attributionName,
      'X-IDE-Version': product.clientVersion,
      'X-Product': product.attributionName,
      'User-Agent': resolveUserAgent(product, model),
    }
  }

  async function postChat(
    credential: BuddyCredential,
    req: ChatRequest,
    upstreamModel: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${product.endpoint}${CHAT_PATH}`
    const response = await fetcher(url, {
      method: 'POST',
      headers: chatHeaders(credential, upstreamModel),
      body: JSON.stringify(toUpstreamBody(req, upstreamModel)),
      signal,
    })
    if (!response.ok) throw await toUpstreamError(response)
    return response
  }

  async function toUpstreamError(response: Response): Promise<UpstreamError> {
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    const lower = text.toLowerCase()
    if (response.status === 401 || lower.includes('invalid token') || lower.includes('unauthorized')) {
      return new UpstreamError({ kind: 'AUTH_INVALID', message: `buddy auth error: HTTP ${response.status}`, status: response.status })
    }
    if (response.status === 429) return new UpstreamError({ kind: 'RATE_LIMIT', message: `buddy rate limited: ${text.slice(0, 200)}`, status: 429 })
    if (response.status === 403) return new UpstreamError({ kind: 'AUTH_INVALID', message: `buddy forbidden: ${text.slice(0, 200)}`, status: 403 })
    if (response.status >= 500) return new UpstreamError({ kind: 'UPSTREAM_5XX', message: `buddy upstream ${response.status}`, status: response.status })
    return new UpstreamError({ kind: 'TERMINAL', message: `buddy HTTP ${response.status}: ${text.slice(0, 200)}`, status: response.status })
  }

  interface SseDelta {
    content?: string
    reasoning_content?: string
    tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
  }

  /** Parse an upstream OpenAI SSE stream into canonical chunks. */
  async function* streamChat(response: Response): AsyncGenerator<ChatChunk> {
    if (!response.body) throw new UpstreamError({ kind: 'EMPTY_RESPONSE', message: 'buddy: empty response body' })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const toolCallIds = new Map<number, string>()
    let finishReason: ChatChunk['finishReason'] = null

    const handleData = (payload: string): ChatChunk | undefined => {
      if (payload === '[DONE]') return undefined
      let json: Record<string, unknown>
      try {
        json = JSON.parse(payload) as Record<string, unknown>
      } catch {
        return undefined
      }
      const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
      const choices = json.choices as Array<Record<string, unknown>> | undefined
      const choice = choices?.[0]
      const delta = (choice?.delta ?? {}) as SseDelta
      const fr = choice?.finish_reason as string | null | undefined
      if (fr === 'stop' || fr === 'length' || fr === 'tool_calls') finishReason = fr
      const chunk: ChatChunk = { text: delta.content ?? '' }
      if (delta.reasoning_content !== undefined) chunk.reasoning = delta.reasoning_content
      if (delta.tool_calls) {
        chunk.toolCalls = delta.tool_calls.map((tc) => {
          const index = tc.index ?? 0
          if (tc.id) toolCallIds.set(index, tc.id)
          return {
            id: toolCallIds.get(index),
            name: tc.function?.name,
            arguments: tc.function?.arguments,
          }
        })
      }
      if (usage) {
        chunk.usage = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
      }
      if (chunk.text === '' && chunk.reasoning === undefined && chunk.toolCalls === undefined && !usage) return undefined
      return chunk
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line.startsWith('data:')) {
          const chunk = handleData(line.slice(5).trim())
          if (chunk) yield chunk
        }
        newlineIndex = buffer.indexOf('\n')
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const chunk = handleData(tail.slice(5).trim())
      if (chunk) yield chunk
    }
    yield { text: '', finishReason: finishReason ?? 'stop' }
  }

  /**
   * Consume the upstream SSE stream and fold it into a single ChatResult
   * (used for clients that asked for `stream: false`).
   *
   * Note: the canonical ChatResult has no tool-call field, so streamed
   * tool_calls cannot be represented on the non-streaming path; text,
   * reasoning and usage are aggregated.
   */
  async function aggregate(response: Response): Promise<ChatResult> {
    let content = ''
    let reasoning = ''
    let finishReason = 'stop'
    let usage: ChatResult['usage']
    for await (const chunk of streamChat(response)) {
      content += chunk.text
      if (chunk.reasoning) reasoning += chunk.reasoning
      if (chunk.usage) usage = chunk.usage
      if (chunk.finishReason) finishReason = chunk.finishReason
    }
    const result: ChatResult = { content, finishReason }
    if (reasoning !== '') result.reasoning = reasoning
    if (usage) result.usage = usage
    return result
  }

  return {
    id: product.id,
    displayName: product.displayName,
    capabilities,
    auth: {
      async beginLogin(input: BeginLoginInput): Promise<BeginLoginResult> {
        const { state, authUrl } = await fetchAuthState(product, fetcher)
        sessions.set(input.accountId, { state, authUrl, startedAt: Date.now() })
        return { loginUrl: authUrl, expiresIn: Math.floor(LOGIN_TTL_MS / 1000), pollInterval: 1 }
      },
      async pollLogin(accountId: string): Promise<PollLoginResult> {
        const session = sessions.get(accountId)
        if (!session) return { done: false, error: 'login session not found or expired' }
        if (Date.now() - session.startedAt > LOGIN_TTL_MS) {
          sessions.delete(accountId)
          return { done: true, success: false, error: 'login timed out' }
        }
        const token = await pollTokenOnce(product, session.state, fetcher)
        if (!token.ready || !token.token) return { done: false }
        const account = await pollAccountOnce(product, session.state, token.token.accessToken, fetcher)
        const accountData = account.ready && account.account ? account.account : { uid: '', nickname: '', enterpriseId: '', accountType: 'personal' }
        const credential = buildCredential(token.token, accountData)
        sessions.delete(accountId)
        return {
          done: true,
          success: true,
          credential,
          expiresAt: credentialExpiresAtMs(credential) ?? null,
          displayName: credential.nickname || undefined,
        }
      },
    },
    ops: {
      async refreshAccount(ctx: ProviderCtx, account: Account): Promise<RefreshResult> {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { refreshable: false, expiresAt: null, refreshed: false, error: 'no credential' }
        try {
          const token = await refreshBuddyToken(product, credential, fetcher)
          const next = buildCredential(token, {
            uid: credential.user_id,
            nickname: credential.nickname,
            enterpriseId: credential.enterprise_id,
            accountType: credential.account_type,
          })
          return { refreshable: true, expiresAt: credentialExpiresAtMs(next) ?? null, refreshed: true }
        } catch (err) {
          if (err instanceof BuddyRefreshExpiredError) {
            throw new UpstreamError({ kind: 'TERMINAL', message: `buddy refresh token expired: ${err.message}` })
          }
          throw err
        }
      },
      async getQuota(): Promise<QuotaSnapshot> {
        return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: Date.now(), rawJson: null }
      },
      /**
       * Daily check-in claim.
       *
       * The authoritative status is read first so the claim endpoint is only
       * called when the activity is running and today's credit is unclaimed:
       * an inactive activity returns `not_available` and an already-claimed day
       * returns `already_claimed`, both without a second upstream call.
       */
      async claimCredits(ctx: ProviderCtx, account: Account): Promise<ClaimOutcome> {
        const credential = await credentialOf(ctx, account)
        if (!credential) throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'buddy: no credential' })
        const status = await fetchCheckinStatus(product, credential, fetcher)
        if (!status) return { kind: 'failed', message: 'could not read check-in status' }
        if (!status.active) return { kind: 'not_available', message: 'check-in activity is not active' }
        if (status.todayCheckedIn) return { kind: 'already_claimed', message: 'already checked in today' }
        return claimDailyCheckin(product, credential, fetcher)
      },
      async healthCheck(ctx: ProviderCtx, account: Account): Promise<{ ok: boolean; error?: string }> {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { ok: false, error: 'no credential' }
        return { ok: isRefreshable(credential) || credential.access_token.length > 0 }
      },
    },
    chat: {
      async listModels(ctx: ProviderCtx, account: Account): Promise<ModelEntry[]> {
        const credential = await credentialOf(ctx, account)
        if (!credential) return []
        const remote = await fetchBuddyModels(product, credential, fetcher)
        return remote.map((m, index) => ({
          modelId: m.id,
          provider: product.id,
          upstreamModel: m.id,
          name: m.name,
          capabilities: { vision: true, toolCall: true, streaming: true },
          enabled: true,
          priority: 100 - index,
          metadataJson: null,
        }))
      },
      async chat(ctx: ProviderCtx, req: ChatRequest, account: Account, _tools?: Tool[]): Promise<ChatResult> {
        const credential = await credentialOf(ctx, account)
        if (!credential) throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'buddy: no credential' })
        // The upstream only speaks SSE, so a non-streaming client is served by
        // consuming the stream and aggregating it into a ChatResult.
        const response = await postChat(credential, req, bareModel(req.model))
        return aggregate(response)
      },
      stream(ctx: ProviderCtx, req: ChatRequest, account: Account, _tools?: Tool[]): AsyncIterable<ChatChunk> {
        const model = bareModel(req.model)
        return (async function* (): AsyncGenerator<ChatChunk> {
          const credential = await credentialOf(ctx, account)
          if (!credential) throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'buddy: no credential' })
          const response = await postChat(credential, { ...req, stream: true }, model)
          yield* streamChat(response)
        })()
      },
    },
  }
}
