/**
 * Qoder provider adapter (international + CN).
 *
 * Qoder's real inference path is **encrypted**: the request body and the
 * `Authorization: Bearer COSY.<payload>.<sig>` header are produced by the
 * official client's WASM (vendored in ./wasm.ts). Core never sees any of this.
 *
 * Differences between the two products are pure config (hosts, client type), so
 * both providers share this adapter.
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
} from '../../core/types.js'
import type {
  BeginLoginResult,
  PollLoginResult,
  Provider,
  ProviderCtx,
  RefreshResult,
} from '../../core/registry/provider.js'
import { UpstreamError } from '../../core/errors/upstream-error.js'
import { QODER, type QoderProduct } from './product.js'
import {
  QODER_CAMPAIGNS_PATH,
  QODER_CHAT_PATH,
  QODER_DEVICE_SELECT_PATH,
  QODER_ENCRYPTED_INFER_PATH,
  QODER_POLL_PATH,
  QODER_REFRESH_PATH,
  QODER_USAGE_PATH,
  QODER_USERINFO_PATH,
} from './product.js'
import {
  buildQoderCredential,
  isQoderRefreshable,
  newQoderMachineId,
  parseQoderCampaigns,
  parseQoderTokenPayload,
  parseQoderUsage,
  qoderCredentialExpiresAtMs,
  qoderHeaders,
  qoderRefreshBody,
  type Fetcher,
  type QoderCredential,
} from './protocol.js'
import {
  QoderEncryptedInfer,
  type QoderInferAsk,
  type QoderInferTool,
} from './wasm.js'

const LOGIN_TTL_MS = 10 * 60 * 1000

export interface QoderProviderOptions {
  product?: QoderProduct
  fetcher?: Fetcher
}

interface LoginSession {
  machineId: string
  authUrl: string
  startedAt: number
  /** device-code challenge identifier returned by the select endpoint */
  flowId?: string
}

export function createQoderProvider(options: QoderProviderOptions = {}): Provider {
  const product = options.product ?? QODER
  const fetcher = options.fetcher ?? fetch
  const sessions = new Map<string, LoginSession>()

  const capabilities: ProviderCapabilities = {
    supportsOAuth: true,
    supportsRefreshToken: true,
    supportsQuota: true,
    // The claim requires the same encrypted/MachineToken machinery and has not
    // been verified live, so it is honestly reported as unsupported.
    supportsCredits: false,
    supportsStreaming: true,
    supportsVision: true,
    supportsToolCall: true,
    supportsMultipleAccounts: true,
    needsCaptcha: false,
    loginMode: 'device-code',
    protocol: 'openai-chat',
  }

  async function credentialOf(ctx: ProviderCtx, account: Account): Promise<QoderCredential | undefined> {
    const handle = await ctx.resolveCredential(account)
    return handle?.credential as QoderCredential | undefined
  }

  function bareModel(model: string): string {
    const sep = model.indexOf('::')
    return sep > 0 ? model.slice(sep + 2) : model
  }

  function classify(status: number, message: string): UpstreamError {
    if (status === 401 || status === 403) return new UpstreamError({ kind: 'AUTH_INVALID', status, message })
    if (status === 429) return new UpstreamError({ kind: 'RATE_LIMIT', status, message })
    if (status >= 500) return new UpstreamError({ kind: 'UPSTREAM_5XX', status, message })
    return new UpstreamError({ kind: 'TERMINAL', status, message })
  }

  /** Build the encrypted request via the vendored WASM. */
  async function encryptedRequest(
    credential: QoderCredential,
    req: ChatRequest,
    modelKey: string,
  ): Promise<{ url: string; headers: Record<string, string>; body: string }> {
    const uid = credential.uid
    if (!uid) {
      throw new UpstreamError({
        kind: 'NEEDS_MANUAL',
        message: 'Qoder credential has no uid; the encrypted inference path requires it',
      })
    }
    const infer = await QoderEncryptedInfer.create({
      user: {
        uid,
        securityOauthToken: credential.security_oauth_token ?? credential.access_token,
        ...(credential.organization_id ? { organizationId: credential.organization_id } : {}),
      },
      machineId: credential.machine_id,
      metadata: { ...product.clientMetadata },
      host: product.inferHost,
      clientVersion: product.clientVersion,
    })
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')
    const systemMessage = req.messages.find((m) => m.role === 'system')
    const ask: QoderInferAsk = {
      modelKey,
      userText: lastUser?.content ?? '',
      history: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls
          ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } })) }
          : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      ...(systemMessage ? { systemText: systemMessage.content } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools as unknown as QoderInferTool[] } : {}),
    }
    return infer.prepareInfer(ask)
  }

  async function* streamChat(ctx: ProviderCtx, account: Account, req: ChatRequest): AsyncIterable<ChatChunk> {
    const credential = await credentialOf(ctx, account)
    if (!credential?.access_token) {
      throw new UpstreamError({ kind: 'AUTH_INVALID', message: 'account has no Qoder access token' })
    }
    const prepared = await encryptedRequest(credential, req, bareModel(req.model))
    // the URL already carries the query; send the WASM-provided headers verbatim
    const res = await fetcher(prepared.url, {
      method: 'POST',
      headers: prepared.headers,
      body: prepared.body,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw classify(res.status, `Qoder encrypted chat failed (HTTP ${res.status}) ${text.slice(0, 160)}`)
    }
    const body = res.body as unknown as AsyncIterable<Uint8Array> | null
    if (!body) throw new UpstreamError({ kind: 'EMPTY_RESPONSE', message: 'Qoder returned no body' })
    // the encrypted endpoint streams SSE; reuse the OpenAI SSE decoder
    const { decodeSseStream } = await import('../../protocol/openai/sse.js')
    for await (const chunk of decodeSseStream(body)) {
      if (chunk.text === '' && chunk.reasoning === undefined && chunk.finishReason == null && !chunk.usage) continue
      yield chunk
    }
  }

  async function aggregate(ctx: ProviderCtx, account: Account, req: ChatRequest): Promise<ChatResult> {
    let content = ''
    let reasoning = ''
    let finishReason: ChatResult['finishReason'] = 'stop'
    let usage: ChatResult['usage']
    for await (const chunk of streamChat(ctx, account, req)) {
      content += chunk.text
      if (chunk.reasoning) reasoning += chunk.reasoning
      if (chunk.finishReason) finishReason = chunk.finishReason
      if (chunk.usage) usage = chunk.usage
    }
    const result: ChatResult = { content, finishReason: finishReason ?? 'stop' }
    if (reasoning !== '') result.reasoning = reasoning
    if (usage) result.usage = usage
    return result
  }

  return {
    id: product.id,
    displayName: product.displayName,
    capabilities,
    auth: {
      async beginLogin(input): Promise<BeginLoginResult> {
        const machineId = newQoderMachineId()
        const challenge = randomChallenge()
        const query = new URLSearchParams({
          challenge,
          challenge_method: 'S256',
          nonce: randomChallenge(),
          machine_id: machineId,
          client_id: product.clientId,
        })
        const selectUrl = `${product.authBase}${QODER_DEVICE_SELECT_PATH}?${query.toString()}`
        // Best-effort: the endpoint returns the account-selection page / flow id.
        let flowId: string | undefined
        try {
          const res = await fetcher(selectUrl, { headers: qoderHeaders(undefined, product) })
          const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
          const data = json && typeof json.data === 'object' && json.data !== null ? (json.data as Record<string, unknown>) : json
          if (data && typeof data.flow_id === 'string') flowId = data.flow_id
        } catch {
          // fall through: the operator can still complete the flow
        }
        const authUrl = `${product.portalBase}/device?machine_id=${encodeURIComponent(machineId)}`
        sessions.set(input.accountId, {
          machineId,
          authUrl,
          startedAt: Date.now(),
          ...(flowId ? { flowId } : {}),
        })
        return { loginUrl: authUrl, deviceCode: flowId, expiresIn: Math.floor(LOGIN_TTL_MS / 1000), pollInterval: 5 }
      },
      async pollLogin(accountId): Promise<PollLoginResult> {
        const session = sessions.get(accountId)
        if (!session) return { done: false, error: 'login session not found or expired' }
        if (Date.now() - session.startedAt > LOGIN_TTL_MS) {
          sessions.delete(accountId)
          return { done: true, success: false, error: 'device code expired' }
        }
        const pollUrl = `${product.authBase}${QODER_POLL_PATH}?machine_id=${encodeURIComponent(session.machineId)}`
        try {
          const res = await fetcher(pollUrl, { headers: qoderHeaders(undefined, product) })
          // the reference treats 404 as "user has not authorised yet"
          if (res.status === 404) return { done: false }
          const payload = parseQoderTokenPayload(await res.json().catch(() => null))
          if (!payload) return { done: false }
          const credential = buildQoderCredential(payload, { machine_id: session.machineId })
          sessions.delete(accountId)
          return {
            done: true,
            success: true,
            credential,
            expiresAt: qoderCredentialExpiresAtMs(credential) ?? null,
            ...(credential.nickname ? { displayName: credential.nickname } : {}),
          }
        } catch {
          return { done: false }
        }
      },
      async importCredential(accountId, _provider, payload) {
        const record = (payload ?? {}) as Record<string, unknown>
        // ready credential blob
        if (typeof record.access_token === 'string' && record.access_token.length > 0) {
          if (typeof record.machine_id !== 'string' || record.machine_id.length === 0) {
            throw new UpstreamError({ kind: 'NEEDS_MANUAL', message: 'a Qoder credential must include machine_id' })
          }
          const credential = record as unknown as QoderCredential
          sessions.delete(accountId)
          return {
            expiresAt: qoderCredentialExpiresAtMs(credential) ?? null,
            refreshable: isQoderRefreshable(credential),
          }
        }
        const token = parseQoderTokenPayload(record)
        if (!token) {
          throw new UpstreamError({
            kind: 'NEEDS_MANUAL',
            message: 'importCredential expects a Qoder credential blob or an access/refresh token pair',
          })
        }
        sessions.delete(accountId)
        const credential = buildQoderCredential(token, { machine_id: newQoderMachineId() })
        return { expiresAt: qoderCredentialExpiresAtMs(credential) ?? null, refreshable: isQoderRefreshable(credential) }
      },
    },
    ops: {
      async refreshAccount(ctx, account): Promise<RefreshResult> {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { refreshable: false, expiresAt: null, refreshed: false, error: 'no credential' }
        if (!isQoderRefreshable(credential)) {
          return { refreshable: false, expiresAt: null, refreshed: false, error: 'not refreshable' }
        }
        const res = await fetcher(`${product.authBase}${QODER_REFRESH_PATH}`, {
          method: 'POST',
          headers: qoderHeaders(credential, product),
          body: JSON.stringify(qoderRefreshBody(credential)),
        })
        const payload = parseQoderTokenPayload(await res.json().catch(() => null))
        if (!payload) {
          throw new UpstreamError({
            kind: res.status === 401 || res.status === 403 ? 'AUTH_INVALID' : 'TERMINAL',
            status: res.status,
            message: `Qoder refresh failed (HTTP ${res.status})`,
          })
        }
        const updated = buildQoderCredential(payload, credential)
        return {
          refreshable: isQoderRefreshable(updated),
          expiresAt: qoderCredentialExpiresAtMs(updated) ?? null,
          refreshed: true,
          credential: updated,
        }
      },
      async getQuota(ctx, account): Promise<QuotaSnapshot> {
        const credential = await credentialOf(ctx, account)
        const now = Date.now()
        if (!credential) {
          return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now, rawJson: null }
        }
        const res = await fetcher(`${product.sashBase}${QODER_USAGE_PATH}`, { headers: qoderHeaders(credential, product) })
        if (!res.ok) {
          return { known: false, remaining: null, total: null, resetAt: null, lastUpdatedAt: now, rawJson: null }
        }
        const usage = parseQoderUsage(await res.json().catch(() => null))
        return {
          known: usage.remaining !== null || usage.total !== null,
          remaining: usage.remaining,
          total: usage.total,
          resetAt: null,
          lastUpdatedAt: now,
          rawJson: JSON.stringify(usage),
        }
      },
      async claimCredits() {
        // Qoder campaigns exist but claiming needs the same device-token
        // machinery that is not verifiable here; reported honestly.
        return { kind: 'unsupported', message: 'Qoder campaign claiming is not implemented (device-token flow unverified)' }
      },
      async healthCheck(ctx, account) {
        const credential = await credentialOf(ctx, account)
        if (!credential) return { ok: false, error: 'no credential' }
        const res = await fetcher(`${product.authBase}${QODER_USERINFO_PATH}`, { headers: qoderHeaders(credential, product) })
        if (res.status === 401 || res.status === 403) return { ok: false, error: `HTTP ${res.status}` }
        return { ok: res.ok || res.status === 404 }
      },
      mapError(err) {
        if (err instanceof UpstreamError) return err
        return new UpstreamError({ kind: 'TRANSPORT', message: err instanceof Error ? err.message : String(err) })
      },
    },
    chat: {
      async listModels(ctx, account): Promise<ModelEntry[]> {
        // The real catalog is encrypted; without a WASM-based decrypt we report
        // the product table rather than inventing entries.
        void ctx
        void account
        return product.fallbackModels.map((m) => ({
          modelId: m.id,
          provider: product.id,
          upstreamModel: m.id,
          name: m.name,
          capabilities: { vision: true, toolCall: true, streaming: true },
          enabled: true,
          priority: 0,
          metadataJson: null,
        }))
      },
      async chat(ctx, req, account) {
        return aggregate(ctx, account, req)
      },
      stream(ctx, req, account, _tools: Tool[]) {
        return streamChat(ctx, account, req)
      },
    },
  }
}

function randomChallenge(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

export { QODER_CAMPAIGNS_PATH, QODER_CHAT_PATH, QODER_ENCRYPTED_INFER_PATH, parseQoderCampaigns }
