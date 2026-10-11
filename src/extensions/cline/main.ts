/**
 * Cline Extension (RFC v2 §24 — provider migration into an extension).
 *
 * Full Cline provider surface: WorkOS device-code login (begin → poll via
 * account detail), credential import, token refresh, dual-endpoint model
 * discovery, balance quota, OpenAI-compatible chat (JSON + SSE, tools
 * supported), upstream error mapping. Reuses the pure protocol primitives
 * from `src/providers/cline/*`.
 *
 * Credential boundary: credentials live in this extension's encrypted store;
 * protocol payloads carry NO credential material; account ids are
 * Core-allocated opaque strings (§10.3).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  buildClineCatalog,
} from '../../providers/cline/models.js'
import {
  buildClineCredential,
  classifyClinePoll,
  clineAnonymousHeaders,
  clineChatHeaders,
  clineCredentialExpiresAtMs,
  clineRefreshBody,
  isClineRefreshable,
  parseClineDeviceAuthorization,
  parseClineTokenPayload,
  type ClineCredential,
} from '../../providers/cline/protocol.js'
import {
  CLINE,
  CLINE_CHAT_PATH,
  CLINE_DEVICE_AUTHORIZATION_PATH,
  CLINE_DEVICE_AUTHENTICATE_PATH,
  CLINE_DEVICE_AUTH_EXPIRES_MS,
  CLINE_DEVICE_AUTH_INTERVAL_MS,
  CLINE_MODELS_PATH,
  CLINE_RECOMMENDED_MODELS_PATH,
  CLINE_REFRESH_PATH,
  CLINE_REGISTER_PATH,
} from '../../providers/cline/product.js'
import { fetchClineBalance, toQuotaSnapshot } from '../../providers/cline/credits.js'
import { decodeSseStream } from '../../protocol/openai/sse.js'
import { ClineCredentialStore } from './credential-store.js'
import type { ExtensionManifest } from '../../protocol/extension/manifest.js'
import type { ChatChunk } from '../../core/types.js'

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

export const CLINE_MANIFEST: ExtensionManifest = {
  apiVersion: '1.0',
  extension: {
    id: 'cline',
    version: '1.0.0',
    displayName: 'Cline',
    description: 'Cline provider extension — device-code login, chat with tools, balance quota',
    license: 'MIT',
  },
  runtime: {
    port: 8080,
    healthPath: '/health',
    env: [
      { name: 'LOG_LEVEL', required: false, default: 'info' },
      { name: 'CLINE_API_BASE', required: false, default: '' },
    ],
    volumes: [
      { name: 'state', mountPath: '/data', purpose: 'encrypted credentials + login sessions' },
    ],
    resources: { memory: '256Mi', cpus: '0.5' },
  },
  providers: [
    {
      id: 'cline',
      displayName: CLINE.displayName,
      protocol: 'openai-chat',
      capabilities: {
        supportsOAuth: true,
        supportsRefreshToken: true,
        supportsQuota: true,
        supportsCredits: false, // Cline has no daily check-in
        supportsStreaming: true,
        supportsVision: true,
        supportsToolCall: true,
        supportsMultipleAccounts: true,
        needsCaptcha: false,
        loginMode: 'device-code',
        protocol: 'openai-chat',
      },
      fallbackModels: CLINE.fallbackModels.map((m) => ({
        id: m.id,
        name: m.name,
        capabilities: { vision: true, toolCall: true, streaming: true },
      })),
      actions: [
        {
          id: 'submit-auth-code',
          httpMethod: 'POST',
          title: 'Submit Cline credential',
          mode: 'write',
          sideEffects: 'one-shot',
          ui: 'form',
          inputSchema: {
            type: 'object',
            properties: { code: { type: 'string' }, account_id: { type: 'string' } },
          },
          outputSchema: { type: 'object' },
        },
      ],
      authAction: 'submit-auth-code',
    },
  ],
}

interface DeviceSession {
  deviceCode: string
  userCode: string
  authUrl: string
  intervalMs: number
  startedAt: number
  expiresAt: number
  failures: number
}

export interface ClineExtensionOptions {
  port?: number
  dataDir?: string
  secret?: string
  fetcher?: typeof fetch
  apiBase?: string
  now?: () => number
}

export async function startClineExtension(opts: ClineExtensionOptions = {}): Promise<{
  server: Server
  port: number
  endpointUrl: string
  store: ClineCredentialStore
}> {
  const fetcher = opts.fetcher ?? fetch
  const now = opts.now ?? Date.now
  const dataDir = opts.dataDir ?? '/data'
  const secret = opts.secret ?? process.env.GATEWAY_EXTENSION_SECRET ?? 'dev-only-insecure-secret'
  const apiBase = opts.apiBase ?? process.env.CLINe_API_BASE ?? process.env.CLINE_API_BASE ?? ''
  const PRODUCT = apiBase ? { ...CLINE, apiBase } : CLINE
  const store = new ClineCredentialStore(dataDir, secret)
  const sessions = new Map<string, DeviceSession>() // accountId → device-code login

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

  function authHeadersFor(credential: ClineCredential): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${clineBearerLocal(credential.access_token)}`,
      ...PRODUCT.clientHeaders,
    }
  }

  function clineBearerLocal(accessToken: string): string {
    return accessToken.startsWith(PRODUCT.tokenPrefix) ? accessToken : PRODUCT.tokenPrefix + accessToken
  }

  function bareOf(model: string): string {
    const sep = model.indexOf('::')
    return sep > 0 ? model.slice(sep + 2) : model
  }

  function chatBody(body: Record<string, unknown>): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: bareOf(typeof body.model === 'string' ? body.model : ''), // bare upstream id
      messages: Array.isArray(body.messages) ? body.messages : [],
      stream: true,
    }
    if (typeof body.max_tokens === 'number') payload.max_tokens = body.max_tokens
    if (typeof body.temperature === 'number') payload.temperature = body.temperature
    if (typeof body.reasoning_effort === 'string') payload.reasoning_effort = body.reasoning_effort
    if (Array.isArray(body.tools) && body.tools.length > 0) payload.tools = body.tools
    return payload
  }

  async function upstreamChatStream(accountId: string, body: Record<string, unknown>): Promise<Response> {
    const credential = store.get(accountId)
    if (!credential?.access_token) throwUp('AUTH_INVALID', 'account has no Cline access token')
    const res = await fetcher(`${PRODUCT.apiBase}${CLINE_CHAT_PATH}`, {
      method: 'POST',
      headers: clineChatHeaders(credential, PRODUCT),
      body: JSON.stringify(chatBody(body)),
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      const c = classify(res.status, `Cline chat failed (HTTP ${res.status})${text ? `: ${text}` : ''}`)
      throwUp(c.kind, c.message, res.status)
    }
    return res
  }

  async function discoverCatalog(accountId: string): Promise<Array<{ id: string; name: string; isFree: boolean }>> {
    // recommended-models needs no auth; /models needs the bearer.
    const recommendedRes = await fetcher(`${PRODUCT.apiBase}${CLINE_RECOMMENDED_MODELS_PATH}`, {
      headers: clineAnonymousHeaders(PRODUCT),
    })
    const recommended = recommendedRes.ok ? await recommendedRes.json().catch(() => null) : null
    const credential = store.get(accountId)
    let allModels: unknown = null
    if (credential?.access_token) {
      const res = await fetcher(`${PRODUCT.apiBase}${CLINE_MODELS_PATH}`, {
        headers: authHeadersFor(credential),
      })
      if (res.ok) allModels = await res.json().catch(() => null)
    }
    return buildClineCatalog({ allModels, recommended })
  }

  async function modelsFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    const catalog = await discoverCatalog(accountId)
    const source = catalog.length > 0 ? catalog : PRODUCT.fallbackModels.map((m) => ({ ...m, isFree: m.id.startsWith('cline-free/') }))
    return {
      models: source.map((m) => ({
        id: m.id,
        name: m.name,
        capabilities: { vision: true, toolCall: true, streaming: true },
        metadata: { free: m.isFree },
      })),
    }
  }

  async function quotaFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    if (!credential) return { accountId, resources: [], checkedAt: new Date().toISOString(), source: 'authoritative' }
    const snapshot = toQuotaSnapshot(await fetchClineBalance(credential, PRODUCT, fetcher))
    return {
      accountId,
      resources: [{
        id: 'credits',
        status: snapshot.known ? (snapshot.remaining !== null && snapshot.remaining <= 0 ? 'exhausted' : 'ok') : 'unknown',
        remaining: snapshot.remaining,
        total: snapshot.total,
        unit: 'credits',
        resetAt: snapshot.resetAt ?? null,
      }],
      checkedAt: new Date().toISOString(),
      source: 'authoritative',
    }
  }

  async function refreshCredential(accountId: string): Promise<{ refreshed: boolean; error?: string }> {
    const credential = store.get(accountId)
    if (!credential) return { refreshed: false, error: 'no credential' }
    if (!isClineRefreshable(credential)) return { refreshed: false, error: 'not refreshable' }
    const res = await fetcher(`${PRODUCT.apiBase}${CLINE_REFRESH_PATH}`, {
      method: 'POST',
      headers: clineAnonymousHeaders(PRODUCT),
      body: JSON.stringify(clineRefreshBody(credential)),
    })
    const token = parseClineTokenPayload(await res.json().catch(() => null))
    if (!token) {
      throwUp(
        res.status === 401 || res.status === 403 ? 'AUTH_INVALID' : 'TERMINAL',
        `Cline refresh failed (HTTP ${res.status})`,
        res.status,
      )
    }
    store.put(accountId, buildClineCredential(token, credential), store.displayName(accountId))
    return { refreshed: true }
  }

  /** Device-code poll — advanced by account-detail reads (Core pollLogin). */
  async function pollDeviceLogin(accountId: string): Promise<{ done: boolean; success?: boolean; error?: string; displayName?: string }> {
    const session = sessions.get(accountId)
    if (!session) return { done: false, error: 'login session not found or expired' }
    if (now() >= session.expiresAt) {
      sessions.delete(accountId)
      return { done: true, success: false, error: 'device code expired' }
    }
    try {
      const res = await fetcher(`${PRODUCT.workOsBase}${CLINE_DEVICE_AUTHENTICATE_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          ...PRODUCT.clientHeaders,
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: session.deviceCode,
          client_id: PRODUCT.workOsClientId,
        }).toString(),
      })
      session.failures = 0
      const outcome = classifyClinePoll(res.status, await res.json().catch(() => null))
      if (outcome.status === 'pending') return { done: false }
      if (outcome.status === 'slow_down') {
        session.intervalMs += outcome.intervalMs
        return { done: false }
      }
      if (outcome.status === 'denied') {
        sessions.delete(accountId)
        return { done: true, success: false, error: outcome.error }
      }
      // Authorized: register the WorkOS token to get the Cline token.
      const registerRes = await fetcher(`${PRODUCT.apiBase}${CLINE_REGISTER_PATH}`, {
        method: 'POST',
        headers: clineAnonymousHeaders(PRODUCT),
        body: JSON.stringify({ accessToken: outcome.accessToken, refreshToken: outcome.refreshToken ?? '' }),
      })
      const token = parseClineTokenPayload(await registerRes.json().catch(() => null))
      if (!token) {
        sessions.delete(accountId)
        return { done: true, success: false, error: `Cline token registration failed (HTTP ${registerRes.status})` }
      }
      const credential = buildClineCredential(token, {})
      store.put(accountId, credential, credential.email ?? null)
      sessions.delete(accountId)
      return { done: true, success: true, displayName: credential.email ?? undefined }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      session.failures += 1
      if (session.failures >= 5) {
        sessions.delete(accountId)
        return { done: true, success: false, error: `device login aborted after repeated errors: ${message}` }
      }
      return { done: false }
    }
  }

  // -- protocol projection ---------------------------------------------------

  function accountsProjection(): unknown {
    return {
      accounts: store.list().map((rec) => {
        const expiresAt = clineCredentialExpiresAtMs(rec.credential)
        const expired = expiresAt !== undefined && now() >= expiresAt
        return {
          accountId: rec.accountId,
          providerId: 'cline',
          displayName: rec.displayName ?? rec.accountId,
          status: !rec.enabled ? 'disabled' : expired ? (isClineRefreshable(rec.credential) ? 'token_expired' : 'auth_failed') : 'active',
          manualAction: null,
          quota: null, // fetched on demand via /quota
          lastError: null,
          lastSuccessAt: new Date(rec.updatedAt).toISOString(),
          lastFailureAt: null,
          metadata: { refreshable: isClineRefreshable(rec.credential) },
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
      if (!done) res.write(chunkToSseEvent({ text: '', finishReason: 'stop' }))
      res.end()
    } catch (err) {
      const e = err as Error & { upKind?: string }
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' })
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

    if (req.method === 'GET' && path === '/manifest') return send(res, 200, CLINE_MANIFEST)
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { status: 'healthy', version: CLINE_MANIFEST.extension.version, accounts: { total: store.list().length, usable: store.list().filter((r) => r.enabled).length } })
    }

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
        : `cline-${randomUUID().slice(0, 8)}`
      if (store.has(requested) || sessions.has(requested)) {
        return send(res, 409, { error: { kind: 'TERMINAL', message: `account ${requested} already exists` } })
      }
      const res2 = await fetcher(`${PRODUCT.workOsBase}${CLINE_DEVICE_AUTHORIZATION_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          ...PRODUCT.clientHeaders,
        },
        body: new URLSearchParams({ client_id: PRODUCT.workOsClientId }).toString(),
      })
      if (!res2.ok) {
        throwUp('UPSTREAM_5XX', `Cline device authorization failed (HTTP ${res2.status})`, res2.status)
      }
      const auth = parseClineDeviceAuthorization(await res2.json().catch(() => null))
      if (!auth) {
        return send(res, 502, { error: { kind: 'TERMINAL', message: 'Cline device authorization response was not understood' } })
      }
      const started = now()
      sessions.set(requested, {
        deviceCode: auth.deviceCode,
        userCode: auth.userCode,
        authUrl: auth.verificationUriComplete ?? auth.verificationUri,
        intervalMs: auth.intervalMs || CLINE_DEVICE_AUTH_INTERVAL_MS,
        startedAt: started,
        expiresAt: started + (auth.expiresInMs || CLINE_DEVICE_AUTH_EXPIRES_MS),
        failures: 0,
      })
      return send(res, 201, {
        accountId: requested,
        status: 'pending',
        authorizationUrl: auth.verificationUriComplete ?? auth.verificationUri,
        userCode: auth.userCode,
        expiresIn: Math.floor((auth.expiresInMs || CLINE_DEVICE_AUTH_EXPIRES_MS) / 1000),
        pollInterval: Math.max(1, Math.floor((auth.intervalMs || CLINE_DEVICE_AUTH_INTERVAL_MS) / 1000)),
      })
    }

    const acctMatch = /^\/v1\/accounts\/([A-Za-z0-9-]+)(?:\/(quota|refresh|claim|enable|disable))?$/.exec(path)
    if (acctMatch) {
      const [, accountId, op] = acctMatch
      if (!op) {
        // Core's pollLogin re-reads this projection: advance the device-code
        // state machine here, exactly like the QR flow in other extensions.
        const pending = sessions.get(accountId)
        const rec = store.list().find((r) => r.accountId === accountId)
        if (!rec && !pending) return send(res, 404, { error: { kind: 'TERMINAL', message: `unknown account ${accountId}` } })
        if (!rec && pending) {
          const poll = await pollDeviceLogin(accountId)
          if (poll.done && !poll.success) {
            return send(res, 200, { account: { accountId, providerId: 'cline', displayName: accountId, status: 'auth_failed', manualAction: null, quota: null, lastError: poll.error ?? 'login failed', lastSuccessAt: null, lastFailureAt: new Date().toISOString(), metadata: {} } })
          }
          if (poll.done && poll.success) {
            const accounts = (accountsProjection() as { accounts: Array<{ accountId: string }> }).accounts
            return send(res, 200, { account: accounts.find((a) => a.accountId === accountId) })
          }
          return send(res, 200, { account: { accountId, providerId: 'cline', displayName: accountId, status: 'pending', manualAction: null, quota: null, lastError: null, lastSuccessAt: null, lastFailureAt: null, metadata: { loginUrl: pending.authUrl, userCode: pending.userCode } } })
        }
        const accounts = (accountsProjection() as { accounts: Array<{ accountId: string }> }).accounts
        return send(res, 200, { account: accounts.find((a) => a.accountId === accountId) })
      }
      if (op === 'quota') return send(res, 200, await quotaFor(accountId))
      if (op === 'refresh') {
        const out = await refreshCredential(accountId)
        const credential = store.get(accountId)
        const expiresAt = credential ? clineCredentialExpiresAtMs(credential) : undefined
        return send(res, 200, { status: out.refreshed ? 'active' : 'auth_failed', refreshed: out.refreshed, error: out.error ?? null, expiresAt: expiresAt ?? null })
      }
      if (op === 'claim') {
        // Cline has no daily check-in — a stable, honest answer.
        return send(res, 200, { outcome: { kind: 'unsupported', message: 'Cline has no daily credit claim' } })
      }
      if (op === 'enable' || op === 'disable') {
        const accepted = store.setEnabled(accountId, op === 'enable')
        const rec = store.list().find((r) => r.accountId === accountId)
        const status = !accepted ? 'unknown' : !rec!.enabled ? 'disabled' : 'active'
        return send(res, 200, { accountId, accepted, status })
      }
    }

    if (req.method === 'POST' && path === '/v1/actions/submit-auth-code') {
      const body = await readJson(req) as { payload?: Record<string, unknown> } | undefined
      const payload = (body?.payload ?? {}) as Record<string, unknown>
      const accountId = typeof payload.account_id === 'string' ? payload.account_id : ''
      if (typeof payload.access_token === 'string' && payload.access_token.length > 0) {
        const credential = payload as unknown as ClineCredential
        const target = accountId || `cline-${randomUUID().slice(0, 8)}`
        store.put(target, credential, credential.email ?? null)
        return send(res, 200, { result: { accepted: true, account_id: target, display_name: credential.email ?? null } })
      }
      const token = parseClineTokenPayload(payload)
      if (!token) {
        return send(res, 200, { result: { accepted: false, error: 'submit expects a Cline credential blob or { accessToken, refreshToken }' } })
      }
      const credential = buildClineCredential(token, {})
      const target = accountId || `cline-${randomUUID().slice(0, 8)}`
      store.put(target, credential, credential.email ?? null)
      return send(res, 200, { result: { accepted: true, account_id: target, display_name: credential.email ?? null } })
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
  await startClineExtension({ port, secret: env.GATEWAY_EXTENSION_SECRET })
  await new Promise(() => undefined)
}
