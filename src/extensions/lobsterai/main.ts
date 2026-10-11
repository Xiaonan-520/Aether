/**
 * LobsterAI Extension (RFC v2 §24 — provider migration into an extension).
 *
 * The FULL LobsterAI provider-specific surface lives here: upstream HTTP,
 * auth-code exchange, token refresh, model discovery, quota retrieval and
 * normalization, OpenAI-compatible chat (SSE), and upstream error mapping —
 * reusing the pure protocol primitives from the existing adapter
 * (`src/providers/lobsterai/protocol.ts`), which move into this extension's
 * deployable unit unchanged.
 *
 * Credential boundary: the extension holds credentials in its own encrypted
 * store; the protocol payloads below contain NO credential material, and
 * account ids are Core-allocated opaque strings (§10.3).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  buildLobsteraiCredential,
  createLobsteraiLoginSession,
  isLobsteraiRefreshable,
  lobsteraiCredentialExpiresAtMs,
  lobsteraiChatHeaders,
  lobsteraiAnonymousHeaders,
  lobsteraiModelsHeaders,
  lobsteraiRefreshBody,
  LOBSTERAI_CHAT_PATH,
  LOBSTERAI_EXCHANGE_PATH,
  LOBSTERAI_MODELS_PATH,
  LOBSTERAI_REFRESH_PATH,
  parseLobsteraiEnvelope,
  parseLobsteraiModels,
  parseLobsteraiTokenPayload,
} from '../../providers/lobsterai/protocol.js'
import { LOBSTERAI } from '../../providers/lobsterai/product.js'
import { claimLobsteraiCredits, fetchLobsteraiBalance } from '../../providers/lobsterai/credits.js'
import { decodeSseStream } from '../../protocol/openai/sse.js'
import { ExtensionCredentialStore } from './credential-store.js'
import type { ExtensionManifest } from '../../protocol/extension/manifest.js'
import type { ChatChunk } from '../../core/types.js'

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

export const LOBSTERAI_MANIFEST: ExtensionManifest = {
  apiVersion: '1.0',
  extension: {
    id: 'lobsterai',
    version: '1.0.0',
    displayName: 'LobsterAI Provider',
    description: 'LobsterAI (有道龙虾) provider extension',
    author: 'xiaonan-520',
    license: 'MIT',
  },
  runtime: {
    port: 8080,
    healthPath: '/health',
    env: [
      { name: 'LOG_LEVEL', required: false, default: 'info' },
      { name: 'LOBSTERAI_API_BASE', required: false, default: '' },
    ],
    volumes: [{ name: 'state', mountPath: '/data', purpose: 'credentials + login sessions' }],
    resources: { memory: '256Mi', cpus: '0.5' },
  },
  security: {
    permissions: {
      network: { domains: ['lobsterai-server.youdao.com', 'lobsterai.youdao.com', 'api-overmind.youdao.com'] },
      filesystem: 'named-volumes-only',
      capabilities: [],
      privileged: false,
    },
  },
  providers: [
    {
      id: 'lobsterai',
      displayName: 'LobsterAI (有道)',
      protocol: 'openai-chat',
      capabilities: {
        supportsOAuth: true,
        supportsRefreshToken: true,
        supportsQuota: true,
        supportsCredits: true,
        supportsStreaming: true,
        supportsVision: true,
        supportsToolCall: true,
        supportsMultipleAccounts: true,
        needsCaptcha: false,
        loginMode: 'external-link',
        protocol: 'openai-chat',
      },
      fallbackModels: [
        { id: 'kimi-k3', name: 'Kimi K3', capabilities: { streaming: true, toolCall: true } },
        { id: 'glm-5', name: 'GLM-5', capabilities: { streaming: true, toolCall: true } },
      ],
      actions: [
        {
          id: 'submit-auth-code',
          httpMethod: 'POST',
          title: 'Submit LobsterAI auth code',
          mode: 'write',
          sideEffects: 'one-shot',
          ui: 'form',
          inputSchema: { type: 'object', properties: { code: { type: 'string' }, account_id: { type: 'string' } }, required: ['code'] },
          outputSchema: { type: 'object', properties: { accepted: { type: 'boolean' }, account_id: { type: 'string' }, display_name: { type: 'string' } }, required: ['accepted'] },
        },
      ],
      authAction: 'submit-auth-code',
      accountFields: [],
    },
  ],
}

// ---------------------------------------------------------------------------
// extension state
// ---------------------------------------------------------------------------

interface LoginPending {
  sessionId: string
  session: ReturnType<typeof createLobsteraiLoginSession>
  authUrl: string
  startedAt: number
}

const LOGIN_TTL_MS = 10 * 60 * 1000

export interface LobsteraiExtensionOptions {
  port?: number
  dataDir?: string
  secret?: string
  fetcher?: typeof fetch
  /**
   * Upstream base override (test seam / private deployments). The Manager can
   * only inject manifest-allowlisted env, so the container form reads it from
   * LOBSTERAI_API_BASE; the default is the public product endpoint.
   */
  apiBase?: string
}

export async function startLobsteraiExtension(opts: LobsteraiExtensionOptions = {}): Promise<{
  server: Server
  port: number
  endpointUrl: string
  store: ExtensionCredentialStore
}> {
  const fetcher = opts.fetcher ?? fetch
  const dataDir = opts.dataDir ?? '/data'
  const secret = opts.secret ?? process.env.GATEWAY_EXTENSION_SECRET ?? 'dev-only-insecure-secret'
  const apiBase = opts.apiBase ?? process.env.LOBSTERAI_API_BASE ?? ''
  const PRODUCT = apiBase ? { ...LOBSTERAI, apiBase } : LOBSTERAI
  const store = new ExtensionCredentialStore(dataDir, secret)

  const loginSessions = new Map<string, LoginPending>() // accountId → pending login
  const versionCache = { value: undefined as string | undefined, at: 0 }

  /** Resolve the client version (cached 12h; falls back per product config). */
  async function clientVersion(): Promise<string> {
    if (versionCache.value && Date.now() - versionCache.at < 12 * 60 * 60 * 1000) return versionCache.value
    try {
      const res = await fetcher(PRODUCT.clientVersionApi, {
        signal: AbortSignal.timeout(5_000),
      })
      const body = await res.json().catch(() => null) as Record<string, unknown> | null
      const data = typeof body?.data === 'object' && body.data !== null ? body.data as Record<string, unknown> : {}
      const version = typeof data.version === 'string' ? data.version : undefined
      if (version) {
        versionCache.value = version
        versionCache.at = Date.now()
        return version
      }
    } catch { /* fall through to fallback */ }
    return PRODUCT.fallbackClientVersion
  }

  function classify(status: number, message: string): { kind: string; message: string } {
    if (status === 401 || status === 403) return { kind: 'AUTH_INVALID', message }
    if (status === 429) return { kind: 'RATE_LIMIT', message }
    if (status >= 500) return { kind: 'UPSTREAM_5XX', message }
    return { kind: 'TERMINAL', message }
  }

  /** Normalize a LobsterAI balance into the protocol multi-resource snapshot. */
  function quotaResources(balance: { known: boolean; remaining: number | null; total: number | null }): unknown {
    if (!balance.known || balance.remaining === null) return []
    return [{
      id: 'credits',
      kind: 'credits',
      remaining: balance.remaining,
      total: balance.total,
      used: balance.total !== null && balance.remaining !== null ? Math.max(0, balance.total - balance.remaining) : null,
      unit: 'credits',
      resetAt: null,
      status: balance.total !== null && balance.remaining / balance.total <= 0.2 ? 'low' : 'ok',
      metadata: { source: 'profile-summary' },
    }]
  }

  // -- upstream exchanges ---------------------------------------------------

  async function exchangeCode(accountId: string, code: string): Promise<{ ok: boolean; error?: string; displayName?: string }> {
    const pending = loginSessions.get(accountId)
    const version = await clientVersion()
    const res = await fetcher(`${PRODUCT.apiBase}${LOBSTERAI_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: lobsteraiAnonymousHeaders(PRODUCT),
      body: JSON.stringify({
        authCode: code,
        firstKeyfrom: pending?.session.firstKeyfrom ?? String(Date.now()),
        latestKeyfrom: String(Date.now()),
        uuid: pending?.session.uuid ?? randomUUID(),
        version,
      }),
    })
    const envelope = parseLobsteraiEnvelope(await res.json().catch(() => null))
    const payload = envelope.ok ? parseLobsteraiTokenPayload(envelope.data) : undefined
    if (!payload) {
      return { ok: false, error: `exchange failed: ${envelope.message || `HTTP ${res.status}`}` }
    }
    const credential = buildLobsteraiCredential(payload, {
      uuid: pending?.session.uuid,
      first_keyfrom: pending?.session.firstKeyfrom,
      latest_keyfrom: String(Date.now()),
    })
    loginSessions.delete(accountId)
    store.put(accountId, credential, credential.nickname ?? null)
    return { ok: true, displayName: credential.nickname ?? undefined }
  }

  async function refreshCredential(accountId: string): Promise<{ refreshed: boolean; error?: string }> {
    const credential = store.get(accountId)
    if (!credential || !isLobsteraiRefreshable(credential)) return { refreshed: false, error: 'not refreshable' }
    const version = await clientVersion()
    const res = await fetcher(`${PRODUCT.apiBase}${LOBSTERAI_REFRESH_PATH}`, {
      method: 'POST',
      headers: lobsteraiAnonymousHeaders(PRODUCT),
      body: JSON.stringify(lobsteraiRefreshBody(credential, version)),
    })
    const envelope = parseLobsteraiEnvelope(await res.json().catch(() => null))
    const payload = envelope.ok ? parseLobsteraiTokenPayload(envelope.data) : undefined
    if (!payload) return { refreshed: false, error: `refresh failed: ${envelope.message || `HTTP ${res.status}`}` }
    const updated = buildLobsteraiCredential(payload, credential)
    store.put(accountId, updated, store.displayName(accountId))
    return { refreshed: true }
  }

  async function upstreamChatStream(accountId: string, body: Record<string, unknown>): Promise<Response> {
    const credential = store.get(accountId)
    if (!credential?.access_token) throwUp('AUTH_INVALID', 'account has no LobsterAI access token')
    const version = await clientVersion()
    const res = await fetcher(`${PRODUCT.apiBase}${LOBSTERAI_CHAT_PATH}`, {
      method: 'POST',
      headers: lobsteraiChatHeaders(credential, PRODUCT, version),
      body: JSON.stringify({ ...body, stream: true }),
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      const c = classify(res.status, `LobsterAI chat failed (HTTP ${res.status})${text ? `: ${text}` : ''}`)
      throwUp(c.kind, c.message, res.status)
    }
    return res
  }

  function throwUp(kind: string, message: string, status?: number): never {
    const err = new Error(message) as Error & { upKind?: string; upStatus?: number }
    err.upKind = kind
    err.upStatus = status
    throw err
  }

  // -- protocol handlers ----------------------------------------------------

  function accountsProjection(): unknown {
    ensureNothing()
    return {
      accounts: store.list().map((rec) => {
        const credential = rec.credential
        const expiresAt = lobsteraiCredentialExpiresAtMs(credential)
        const status = !rec.enabled
          ? 'disabled'
          : expiresAt !== undefined && Date.now() >= expiresAt
            ? (isLobsteraiRefreshable(credential) ? 'token_expired' : 'auth_failed')
            : 'active'
        return {
          accountId: rec.accountId,
          providerId: 'lobsterai',
          displayName: rec.displayName ?? rec.accountId,
          status,
          manualAction: null, // lobsterai has no captcha; auth flows via actions
          quota: null, // fetched on demand via /quota
          lastError: null,
          lastSuccessAt: new Date(rec.updatedAt).toISOString(),
          lastFailureAt: null,
          metadata: { refreshable: isLobsteraiRefreshable(credential) },
        }
      }),
    }
  }

  function ensureNothing(): void {
    // placeholder for future invariants; keeps shape stable
  }

  async function modelsFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    const version = await clientVersion()
    let remote: Array<{ id: string; name: string; contextWindow?: number }> = []
    if (credential?.access_token) {
      const res = await fetcher(`${PRODUCT.apiBase}${LOBSTERAI_MODELS_PATH}`, {
        headers: lobsteraiModelsHeaders(credential, PRODUCT, version),
      })
      if (res.ok) remote = parseLobsteraiModels(await res.json().catch(() => null))
    }
    const source = remote.length > 0 ? remote : LOBSTERAI.fallbackModels.map((m) => ({ ...m }))
    return {
      models: source.map((m) => ({
        id: m.id,
        name: m.name,
        capabilities: { vision: true, toolCall: true, streaming: true },
      })),
    }
  }

  async function quotaFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    if (!credential) return { accountId, resources: [], checkedAt: new Date().toISOString(), source: 'authoritative' }
    const balance = await fetchLobsteraiBalance({ product: LOBSTERAI, credential, clientVersion: await clientVersion(), fetcher })
    return {
      accountId,
      resources: quotaResources(balance),
      checkedAt: new Date().toISOString(),
      source: 'authoritative',
    }
  }

  function chunkToSseEvent(chunk: ChatChunk): string {
    return `event: chunk\ndata: ${JSON.stringify(chunk)}\n\n`
  }

  async function handleChatStream(accountId: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const upstream = await upstreamChatStream(accountId, body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let done = false
    try {
      for await (const chunk of decodeSseStream(upstream.body as unknown as AsyncIterable<Uint8Array>)) {
        if (chunk.finishReason) {
          res.write(`event: done\ndata: ${JSON.stringify({ finishReason: chunk.finishReason, usage: chunk.usage })}\n\n`)
          done = true
          break
        }
        if (chunk.text === '' && chunk.reasoning === undefined && !chunk.usage && !chunk.toolCalls?.length) continue
        res.write(chunkToSseEvent(chunk))
      }
      if (!done) res.write(`event: done\ndata: ${JSON.stringify({ finishReason: 'stop' })}\n\n`)
    } catch (err) {
      const e = err as Error & { upKind?: string }
      res.write(`event: error\ndata: ${JSON.stringify({ error: { kind: e.upKind ?? 'TRANSPORT', message: e.message } })}\n\n`)
    } finally {
      res.end()
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://ext.internal')
    const path = url.pathname

    if (req.method === 'GET' && path === '/manifest') return send(res, 200, LOBSTERAI_MANIFEST)
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { status: 'healthy', version: LOBSTERAI_MANIFEST.extension.version, accounts: { total: store.list().length, usable: store.list().filter((r) => r.enabled).length } })
    }

    // ---- model/account/chat/actions require the extension token ----
    if (!verifyAuth(req)) return send(res, 401, { error: { kind: 'AUTH_INVALID', message: 'bad extension token' } })

    if (req.method === 'GET' && path === '/v1/models') {
      const accountId = url.searchParams.get('account_id') ?? store.list()[0]?.accountId
      return send(res, 200, await modelsFor(accountId ?? ''))
    }

    if (req.method === 'GET' && path === '/v1/accounts') return send(res, 200, accountsProjection())

    if (req.method === 'POST' && path === '/v1/accounts') {
      const body = await readJson(req) as Record<string, unknown> | undefined
      if (body && ['access_token', 'refresh_token', 'password', 'api_key', 'secret'].some((k) => k in (body as object))) {
        return send(res, 400, { error: { kind: 'PROTOCOL_VIOLATION', message: 'credential fields are forbidden in account creation (RFC §10.3)' } })
      }
      // Core-allocated account id when provided (§3.5: Core is the account
      // authority; the extension addresses accounts by the caller's opaque id).
      const requested = typeof body?.accountId === 'string' && body.accountId.length > 0
        ? body.accountId
        : `lobsterai-${randomUUID().slice(0, 8)}`
      if (store.has(requested) || loginSessions.has(requested)) {
        return send(res, 409, { error: { kind: 'TERMINAL', message: `account ${requested} already exists` } })
      }
      const accountId = requested
      const session = createLobsteraiLoginSession()
      const authUrl = `${LOBSTERAI.portalBase}/portal#/login?source=electron&redirect_uri=${encodeURIComponent('http://127.0.0.1:17650/auth/callback')}&state=${accountId}`
      loginSessions.set(accountId, { sessionId: session.uuid, session, authUrl, startedAt: Date.now() })
      return send(res, 201, {
        accountId,
        status: 'pending',
        authorizationUrl: authUrl,
        expiresIn: Math.floor(LOGIN_TTL_MS / 1000),
        pollInterval: 2,
      })
    }

    const acctMatch = /^\/v1\/accounts\/([A-Za-z0-9-]+)(?:\/(quota|refresh|claim|enable|disable))?$/.exec(path)
    if (acctMatch) {
      const [, accountId, op] = acctMatch
      if (!op) {
        // pending logins are visible accounts too — Core's pollLogin reads
        // this projection to decide whether the login is still in flight
        const pending = loginSessions.get(accountId)
        const rec = store.list().find((r) => r.accountId === accountId)
        if (!rec && !pending) return send(res, 404, { error: { kind: 'TERMINAL', message: `unknown account ${accountId}` } })
        const accounts = (accountsProjection() as { accounts: Array<{ accountId: string }> }).accounts
        const projected = accounts.find((a) => a.accountId === accountId)
        if (projected) return send(res, 200, { account: projected })
        return send(res, 200, {
          account: {
            accountId,
            providerId: 'lobsterai',
            displayName: accountId,
            status: 'needs_manual_action',
            manualAction: 'submit-auth-code',
            quota: null,
            lastError: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            metadata: {},
          },
        })
      }
      if (op === 'quota') return send(res, 200, await quotaFor(accountId))
      if (op === 'refresh') {
        const out = await refreshCredential(accountId)
        const credential = store.get(accountId)
        const expiresAt = credential ? lobsteraiCredentialExpiresAtMs(credential) : undefined
        return send(res, 200, { status: out.refreshed ? 'active' : 'auth_failed', refreshed: out.refreshed, error: out.error ?? null, expiresAt: expiresAt ?? null })
      }
      if (op === 'claim') {
        const credential = store.get(accountId)
        if (!credential) return send(res, 200, { outcome: { kind: 'needs_auth', message: 'no credential' } })
        const outcome = await claimLobsteraiCredits({ product: PRODUCT, credential, clientVersion: await clientVersion(), fetcher })
        return send(res, 200, { outcome })
      }
      if (op === 'enable' || op === 'disable') {
        const accepted = store.setEnabled(accountId, op === 'enable')
        return send(res, 200, { accountId, accepted, status: accepted ? 'active' : 'auth_failed' })
      }
    }

    if (req.method === 'POST' && path === '/v1/actions/submit-auth-code') {
      const body = await readJson(req) as { payload?: { code?: string; account_id?: string } } | undefined
      const code = body?.payload?.code
      const accountId = body?.payload?.account_id
      if (typeof code !== 'string' || code.length === 0) {
        return send(res, 400, { error: { kind: 'TERMINAL', message: 'missing "code"' } })
      }
      if (typeof accountId !== 'string' || !loginSessions.has(accountId)) {
        return send(res, 404, { error: { kind: 'TERMINAL', message: `no pending login for account ${String(accountId)}` } })
      }
      const out = await exchangeCode(accountId, code)
      if (!out.ok) return send(res, 200, { result: { accepted: false, error: out.error } })
      return send(res, 200, { result: { accepted: true, account_id: accountId, display_name: out.displayName ?? null } })
    }

    if (req.method === 'POST' && path === '/v1/chat') {
      const body = await readJson(req) as Record<string, unknown>
      const accountId = String(body.accountId ?? '')
      if (!store.has(accountId)) {
        return send(res, 404, { error: { kind: 'AUTH_INVALID', message: `unknown account ${accountId}` } })
      }
      if (body.stream === true) {
        await handleChatStream(accountId, body, res)
        return
      }
      // non-streaming: aggregate the stream
      const upstream = await upstreamChatStream(accountId, body)
      let content = ''
      let reasoning = ''
      let finishReason = 'stop'
      let usage: Record<string, number> | undefined
      for await (const chunk of decodeSseStream(upstream.body as unknown as AsyncIterable<Uint8Array>)) {
        content += chunk.text
        if (chunk.reasoning) reasoning += chunk.reasoning
        if (chunk.finishReason) finishReason = chunk.finishReason
        if (chunk.usage) usage = chunk.usage as Record<string, number>
      }
      const out: Record<string, unknown> = { content, finishReason }
      if (reasoning !== '') out.reasoning = reasoning
      if (usage) out.usage = usage
      return send(res, 200, out)
    }

    return send(res, 404, { error: { kind: 'TERMINAL', message: `no such route ${req.method} ${path}` } })
  }

  function verifyAuth(req: IncomingMessage): boolean {
    const expected = process.env.GATEWAY_EXTENSION_TOKEN
    if (!expected) return true // dev/test mode without a manager
    const presented = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    return presented === expected
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      const e = err as Error & { upKind?: string; upStatus?: number }
      send(res, 502, { error: { kind: e.upKind ?? 'TRANSPORT', message: e.message } })
    })
  })

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '0.0.0.0', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : (opts.port ?? 8080)
      resolve({ server, port, endpointUrl: `http://127.0.0.1:${port}`, store })
    })
  })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) as unknown : undefined
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Local runtime boot contract: run(port, env). */
export async function run(port: number, env: Record<string, string> = {}): Promise<void> {
  await startLobsteraiExtension({ port, secret: env.GATEWAY_EXTENSION_SECRET })
  await new Promise(() => undefined)
}
