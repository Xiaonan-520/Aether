/**
 * Raccoon Extension (RFC v2 §24 — provider migration into an extension).
 *
 * The full Raccoon provider surface lives here: WeChat QR login polling,
 * credential import (SMS refused), token refresh, model discovery, quota and
 * login-reward claim, OpenAI-compatible chat (JSON + SSE), and upstream error
 * mapping — reusing the pure protocol primitives from the in-process adapter
 * (`src/providers/raccoon/*`), which stay the shared protocol module.
 *
 * Credential boundary: this extension holds credentials in its own encrypted
 * store; protocol payloads carry NO credential material; account ids are
 * Core-allocated opaque strings (§10.3).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  buildQrImageUrl,
  generateQrCode,
  isRaccoonRefreshable,
  mergeRaccoonCredential,
  parseRaccoonEnvelope,
  parseRaccoonModelCatalog,
  raccoonAuthHeaders,
  raccoonCredentialExpiresAtMs,
  type RaccoonCredential,
  type RaccoonQrStatus,
} from '../../providers/raccoon/protocol.js'
import {
  RACCOON,
  RACCOON_CHAT_PATH,
  RACCOON_LOGIN_TIMEOUT_MS,
  RACCOON_MODEL_CATALOG_PATH,
  RACCOON_QR_LOGIN_PATH,
  RACCOON_REFRESH_PATH,
  RACCOON_USER_INFO_PATH,
} from '../../providers/raccoon/product.js'
import { claimRaccoonLoginReward, fetchRaccoonBalance } from '../../providers/raccoon/credits.js'
import { decodeSseStream } from '../../protocol/openai/sse.js'
import { RaccoonCredentialStore } from './credential-store.js'
import type { ExtensionManifest } from '../../protocol/extension/manifest.js'
import type { ChatChunk } from '../../core/types.js'

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

export const RACCOON_MANIFEST: ExtensionManifest = {
  apiVersion: '1.0',
  extension: {
    id: 'raccoon',
    version: '1.0.0',
    displayName: 'Raccoon',
    description: 'Raccoon (SenseNova) provider extension — WeChat QR login, chat, quota, login reward',
    license: 'MIT',
  },
  runtime: {
    port: 8080,
    healthPath: '/health',
    env: [
      { name: 'LOG_LEVEL', required: false, default: 'info' },
      { name: 'RACCOON_API_BASE', required: false, default: '' },
    ],
    volumes: [
      { name: 'state', mountPath: '/data', purpose: 'encrypted credentials + login sessions' },
    ],
    resources: { memory: '256Mi', cpus: '0.5' },
  },
  providers: [
    {
      id: 'raccoon',
      displayName: RACCOON.displayName,
      protocol: 'openai-chat',
      capabilities: {
        supportsOAuth: true,
        supportsRefreshToken: true,
        supportsQuota: true,
        supportsCredits: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsToolCall: false,
        supportsMultipleAccounts: true,
        needsCaptcha: false,
        loginMode: 'external-link',
        protocol: 'openai-chat',
      },
      fallbackModels: RACCOON.fallbackModels.map((m) => ({
        id: m.id,
        name: m.name,
        capabilities: { vision: false, toolCall: false, streaming: true },
      })),
      actions: [
        {
          id: 'submit-auth-code',
          httpMethod: 'POST',
          title: 'Submit Raccoon credential',
          mode: 'write',
          sideEffects: 'one-shot',
          ui: 'form',
          inputSchema: {
            type: 'object',
            properties: { code: { type: 'string' }, account_id: { type: 'string' } },
            required: ['code'],
          },
          outputSchema: { type: 'object' },
        },
      ],
      authAction: 'submit-auth-code',
    },
  ],
}

// ---------------------------------------------------------------------------
// login session state (process RAM; a manager restart drops in-flight logins,
// matching the in-process adapter's semantics)
// ---------------------------------------------------------------------------

interface QrSession {
  qrcodeCode: string
  qrUrl: string
  startedAt: number
}

const QR_STATUS: Record<number, RaccoonQrStatus> = {
  0: 'pending',
  1: 'logging',
  2: 'canceled',
  3: 'success',
}

export interface RaccoonExtensionOptions {
  port?: number
  dataDir?: string
  secret?: string
  fetcher?: typeof fetch
  apiBase?: string
  now?: () => number
}

export async function startRaccoonExtension(opts: RaccoonExtensionOptions = {}): Promise<{
  server: Server
  port: number
  endpointUrl: string
  store: RaccoonCredentialStore
}> {
  const fetcher = opts.fetcher ?? fetch
  const now = opts.now ?? Date.now
  const dataDir = opts.dataDir ?? '/data'
  const secret = opts.secret ?? process.env.GATEWAY_EXTENSION_SECRET ?? 'dev-only-insecure-secret'
  const apiBase = opts.apiBase ?? process.env.RACCOON_API_BASE ?? ''
  const PRODUCT = apiBase ? { ...RACCOON, apiBase } : RACCOON
  const store = new RaccoonCredentialStore(dataDir, secret)
  const loginSessions = new Map<string, QrSession>() // accountId → pending QR login

  function classify(status: number, message: string): { kind: string; message: string } {
    if (status === 401 || status === 403) return { kind: 'AUTH_INVALID', message }
    if (status === 429) return { kind: 'RATE_LIMIT', message }
    if (status >= 500) return { kind: 'UPSTREAM_5XX', message }
    return { kind: 'TERMINAL', message }
  }

  function throwUp(kind: string, message: string, status?: number): never {
    const err = new Error(message) as Error & { upKind?: string; upStatus?: number }
    err.upKind = kind
    err.upStatus = status
    throw err
  }

  // -- upstream operations ---------------------------------------------------

  async function upstreamChatStream(accountId: string, body: Record<string, unknown>): Promise<Response> {
    const credential = store.get(accountId)
    if (!credential?.access_token) throwUp('AUTH_INVALID', 'account has no Raccoon access token')
    const model = typeof body.model === 'string' ? body.model : ''
    const sep = model.indexOf('::')
    const payload: Record<string, unknown> = {
      model: sep > 0 ? model.slice(sep + 2) : model, // upstream gets the bare id, never the namespace
      messages: Array.isArray(body.messages) ? body.messages : [],
      stream: true,
    }
    if (typeof body.max_tokens === 'number') payload.max_tokens = body.max_tokens
    if (typeof body.temperature === 'number') payload.temperature = body.temperature
    const res = await fetcher(`${PRODUCT.apiBase}${PRODUCT.llmApiPrefix}${RACCOON_CHAT_PATH}`, {
      method: 'POST',
      headers: raccoonAuthHeaders(credential, PRODUCT),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      const c = classify(res.status, `Raccoon chat failed (HTTP ${res.status})${text ? `: ${text}` : ''}`)
      throwUp(c.kind, c.message, res.status)
    }
    return res
  }

  async function modelsFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    let remote: Array<{ id: string; name: string }> = []
    if (credential) {
      const res = await fetcher(`${PRODUCT.apiBase}${PRODUCT.llmApiPrefix}${RACCOON_MODEL_CATALOG_PATH}`, {
        headers: raccoonAuthHeaders(credential, PRODUCT),
      })
      if (res.ok) remote = parseRaccoonModelCatalog(await res.json().catch(() => null))
    }
    const source = remote.length > 0 ? remote : PRODUCT.fallbackModels.map((m) => ({ ...m }))
    return {
      models: source.map((m) => ({
        id: m.id,
        name: m.name,
        capabilities: { vision: false, toolCall: false, streaming: true },
      })),
    }
  }

  async function quotaFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    if (!credential) return { accountId, resources: [], checkedAt: new Date().toISOString(), source: 'authoritative' }
    const balance = await fetchRaccoonBalance({ product: PRODUCT, credential, fetcher })
    return {
      accountId,
      resources: [{
        id: 'credits',
        status: balance.known ? (balance.remaining !== null && balance.remaining <= 0 ? 'exhausted' : 'ok') : 'unknown',
        remaining: balance.remaining,
        total: balance.total,
        unit: 'credits',
        resetAt: balance.resetAt ?? null,
      }],
      checkedAt: new Date().toISOString(),
      source: 'authoritative',
    }
  }

  async function refreshCredential(accountId: string): Promise<{ refreshed: boolean; error?: string }> {
    const credential = store.get(accountId)
    if (!credential) return { refreshed: false, error: 'no credential' }
    if (!isRaccoonRefreshable(credential)) return { refreshed: false, error: 'not refreshable' }
    const res = await fetcher(`${PRODUCT.apiBase}${PRODUCT.authApiPrefix}${RACCOON_REFRESH_PATH}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': PRODUCT.userAgent },
      body: JSON.stringify({ refresh_token: credential.refresh_token }),
    })
    const envelope = parseRaccoonEnvelope(await res.json().catch(() => null))
    if (!envelope.ok || typeof envelope.data.access_token !== 'string') {
      throwUp(
        res.status === 401 || res.status === 403 ? 'AUTH_INVALID' : 'TERMINAL',
        `Raccoon refresh failed (HTTP ${res.status})`,
        res.status,
      )
    }
    // keep the old refresh token when the server omits a new one
    store.put(accountId, mergeRaccoonCredential(envelope.data, credential), store.displayName(accountId))
    return { refreshed: true }
  }

  async function pollQrLogin(accountId: string): Promise<unknown> {
    const session = loginSessions.get(accountId)
    if (!session) return { done: false, error: 'login session not found or expired' }
    if (now() - session.startedAt > RACCOON_LOGIN_TIMEOUT_MS) {
      loginSessions.delete(accountId)
      return { done: true, success: false, error: 'QR code expired' }
    }
    try {
      const res = await fetcher(`${PRODUCT.apiBase}${PRODUCT.authApiPrefix}${RACCOON_QR_LOGIN_PATH}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': PRODUCT.userAgent },
        body: JSON.stringify({ qrcode_code: session.qrcodeCode }),
      })
      const envelope = parseRaccoonEnvelope(await res.json().catch(() => null))
      if (!envelope.ok) return { done: false } // any anomaly degrades to pending
      const rawStatus = typeof envelope.data.status === 'number' ? envelope.data.status : undefined
      const status: RaccoonQrStatus = rawStatus !== undefined ? (QR_STATUS[rawStatus] ?? 'pending') : 'pending'
      if (status === 'canceled') {
        loginSessions.delete(accountId)
        return { done: true, success: false, error: 'QR login canceled by user' }
      }
      if (status !== 'success') return { done: false }
      const accessToken = typeof envelope.data.access_token === 'string' ? envelope.data.access_token : ''
      if (accessToken.length === 0) return { done: false } // success without a token is still pending
      const credential = mergeRaccoonCredential(envelope.data, { device_id: session.qrcodeCode }) as RaccoonCredential
      store.put(accountId, credential, credential.nickname ?? null)
      loginSessions.delete(accountId)
      return {
        done: true,
        success: true,
        expiresAt: raccoonCredentialExpiresAtMs(credential) ?? null,
        ...(credential.nickname ? { displayName: credential.nickname } : {}),
      }
    } catch {
      return { done: false }
    }
  }

  // -- protocol projection ---------------------------------------------------

  function accountsProjection(): unknown {
    return {
      accounts: store.list().map((rec) => {
        const credential = rec.credential
        const expiresAt = raccoonCredentialExpiresAtMs(credential)
        const status = !rec.enabled
          ? 'disabled'
          : expiresAt !== undefined && now() >= expiresAt
            ? (isRaccoonRefreshable(credential) ? 'token_expired' : 'auth_failed')
            : 'active'
        return {
          accountId: rec.accountId,
          providerId: 'raccoon',
          displayName: rec.displayName ?? rec.accountId,
          status,
          manualAction: null,
          quota: null, // fetched on demand via /quota
          lastError: null,
          lastSuccessAt: new Date(rec.updatedAt).toISOString(),
          lastFailureAt: null,
          metadata: { refreshable: isRaccoonRefreshable(credential) },
        }
      }),
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
        if (chunk.finishReason) done = true
        res.write(chunkToSseEvent(chunk))
      }
      if (!done) {
        res.write(chunkToSseEvent({ text: '', finishReason: 'stop' }))
      }
      res.end()
    } catch (err) {
      const e = err as Error & { upKind?: string }
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
      }
      res.write(`event: error\ndata: ${JSON.stringify({ error: { kind: e.upKind ?? 'TRANSPORT', message: e.message } })}\n\n`)
      res.end()
    }
  }

  function verifyAuth(req: IncomingMessage): boolean {
    const expected = process.env.GATEWAY_EXTENSION_TOKEN
    if (!expected) return true // dev/test mode without a manager
    const presented = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    return presented === expected
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://ext.internal')
    const path = url.pathname

    if (req.method === 'GET' && path === '/manifest') return send(res, 200, RACCOON_MANIFEST)
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { status: 'healthy', version: RACCOON_MANIFEST.extension.version, accounts: { total: store.list().length, usable: store.list().filter((r) => r.enabled).length } })
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
      const requested = typeof body?.accountId === 'string' && body.accountId.length > 0
        ? body.accountId
        : `raccoon-${randomUUID().slice(0, 8)}`
      if (store.has(requested) || loginSessions.has(requested)) {
        return send(res, 409, { error: { kind: 'TERMINAL', message: `account ${requested} already exists` } })
      }
      const qrcodeCode = generateQrCode()
      const qrUrl = buildQrImageUrl(PRODUCT, qrcodeCode)
      loginSessions.set(requested, { qrcodeCode, qrUrl, startedAt: now() })
      return send(res, 201, {
        accountId: requested,
        status: 'pending',
        authorizationUrl: qrUrl,
        expiresIn: Math.floor(RACCOON_LOGIN_TIMEOUT_MS / 1000),
        pollInterval: 2,
      })
    }

    const acctMatch = /^\/v1\/accounts\/([A-Za-z0-9-]+)(?:\/(quota|refresh|claim|enable|disable))?$/.exec(path)
    if (acctMatch) {
      const [, accountId, op] = acctMatch
      if (!op) {
        // pending logins are visible accounts too — Core's pollLogin re-reads
        // this projection, so advancing the QR state machine here (rather than
        // on a separate poll route) is what drives the login to completion
        const pending = loginSessions.get(accountId)
        const rec = store.list().find((r) => r.accountId === accountId)
        if (!rec && !pending) return send(res, 404, { error: { kind: 'TERMINAL', message: `unknown account ${accountId}` } })
        if (!rec && pending) {
          const poll = await pollQrLogin(accountId) as { done?: boolean; success?: boolean; error?: string }
          if (poll.done && !poll.success) {
            return send(res, 200, { account: { accountId, providerId: 'raccoon', displayName: accountId, status: 'auth_failed', manualAction: null, quota: null, lastError: poll.error ?? 'login failed', lastSuccessAt: null, lastFailureAt: new Date().toISOString(), metadata: {} } })
          }
          if (poll.done && poll.success) {
            const accounts = (accountsProjection() as { accounts: Array<{ accountId: string }> }).accounts
            return send(res, 200, { account: accounts.find((a) => a.accountId === accountId) })
          }
          return send(res, 200, { account: { accountId, providerId: 'raccoon', displayName: accountId, status: 'pending', manualAction: null, quota: null, lastError: null, lastSuccessAt: null, lastFailureAt: null, metadata: { loginUrl: pending.qrUrl } } })
        }
        const accounts = (accountsProjection() as { accounts: Array<{ accountId: string }> }).accounts
        return send(res, 200, { account: accounts.find((a) => a.accountId === accountId) })
      }
      if (op === 'quota') return send(res, 200, await quotaFor(accountId))
      if (op === 'refresh') {
        const out = await refreshCredential(accountId)
        const credential = store.get(accountId)
        const expiresAt = credential ? raccoonCredentialExpiresAtMs(credential) : undefined
        return send(res, 200, { status: out.refreshed ? 'active' : 'auth_failed', refreshed: out.refreshed, error: out.error ?? null, expiresAt: expiresAt ?? null })
      }
      if (op === 'claim') {
        const credential = store.get(accountId)
        if (!credential) return send(res, 200, { outcome: { kind: 'needs_auth', message: 'no credential' } })
        const outcome = await claimRaccoonLoginReward({ product: PRODUCT, credential, fetcher })
        return send(res, 200, { outcome })
      }
      if (op === 'enable' || op === 'disable') {
        const accepted = store.setEnabled(accountId, op === 'enable')
        // status mirrors the projection for the toggled account
        const rec = store.list().find((r) => r.accountId === accountId)
        const expiresAt = rec ? raccoonCredentialExpiresAtMs(rec.credential) : undefined
        const status = !accepted
          ? 'unknown'
          : !rec!.enabled
            ? 'disabled'
            : 'active'
        void expiresAt
        return send(res, 200, { accountId, accepted, status })
      }
    }

    if (req.method === 'POST' && path === '/v1/actions/submit-auth-code') {
      const body = await readJson(req) as { payload?: { code?: unknown; account_id?: unknown } } | undefined
      const payload = (body?.payload ?? {}) as Record<string, unknown>
      const accountId = typeof payload.account_id === 'string' ? payload.account_id : ''
      // SMS login is refused: it needs an Aliyun slider captcha, which is not
      // solved or bypassed here.
      if (payload.sms === true || typeof payload.phone === 'string') {
        return send(res, 200, { result: { accepted: false, error: 'Raccoon SMS login requires an Aliyun slider captcha; use the WeChat QR flow instead' } })
      }
      if (typeof payload.code !== 'string' || payload.code.length === 0) {
        return send(res, 400, { error: { kind: 'TERMINAL', message: 'missing "code"' } })
      }
      let credential: RaccoonCredential
      try {
        credential = mergeRaccoonCredential(payload, payload as Partial<RaccoonCredential>) as RaccoonCredential
      } catch {
        return send(res, 200, { result: { accepted: false, error: 'credential payload could not be parsed' } })
      }
      if (typeof credential.access_token !== 'string' || credential.access_token.length === 0) {
        return send(res, 200, { result: { accepted: false, error: 'credential payload has no access_token (use the QR flow to obtain one)' } })
      }
      if (accountId) loginSessions.delete(accountId)
      const target = accountId || `raccoon-${randomUUID().slice(0, 8)}`
      store.put(target, credential, credential.nickname ?? null)
      return send(res, 200, { result: { accepted: true, account_id: target, display_name: credential.nickname ?? null } })
    }

    if (req.method === 'POST' && path === '/v1/chat') {
      const body = await readJson(req) as Record<string, unknown>
      const accountId = String(body.accountId ?? '')
      if (!store.has(accountId)) return send(res, 404, { error: { kind: 'TERMINAL', message: `unknown account ${accountId}` } })
      if (body.stream === true) return handleChatStream(accountId, body, res)
      let content = ''
      let reasoning = ''
      let finishReason: string | null = null
      let usage: Record<string, unknown> | undefined
      try {
        const upstream = await upstreamChatStream(accountId, body)
        for await (const chunk of decodeSseStream(upstream.body as unknown as AsyncIterable<Uint8Array>)) {
          content += chunk.text
          if (chunk.reasoning) reasoning += chunk.reasoning
          if (chunk.finishReason) finishReason = chunk.finishReason
          if (chunk.usage) usage = chunk.usage as Record<string, unknown>
        }
      } catch (err) {
        const e = err as Error & { upKind?: string; upStatus?: number }
        return send(res, 502, { error: { kind: e.upKind ?? 'TRANSPORT', message: e.message } })
      }
      const out: Record<string, unknown> = { content, finishReason: finishReason ?? 'stop' }
      if (reasoning !== '') out.reasoning = reasoning
      if (usage) out.usage = usage
      return send(res, 200, out)
    }

    return send(res, 404, { error: { kind: 'TERMINAL', message: `no such route ${req.method} ${path}` } })
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
  await startRaccoonExtension({ port, secret: env.GATEWAY_EXTENSION_SECRET })
  await new Promise(() => undefined)
}
