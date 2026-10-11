/**
 * TRAE Extension (RFC v2 §24 — provider migration into an extension).
 *
 * Full TRAE provider surface for ONE product instance: external-link login
 * (operator pastes the callback refresh token), ExchangeToken refresh with a
 * persisted device identity, model discovery, SOLO-protocol chat (SSE), quota
 * and credit claim, upstream error mapping. Reuses the pure protocol
 * primitives from `src/providers/trae/*`.
 *
 * Multi-product note: the image is built once and installed twice (trae /
 * trae-intl) with different manifests — provider id always comes from the
 * real `product.id`, never a hard-coded literal.
 *
 * Credential boundary: credentials live in this extension's encrypted store;
 * protocol payloads carry NO credential material; account ids are
 * Core-allocated opaque strings (§10.3).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  newTraeDeviceIdentity,
  parseTraeBatchModelList,
  parseTraeSoloEvents,
  traeSOLOHeaders,
  transformToSOLOBody,
  type TraeCredential,
} from '../../providers/trae/protocol.js'
import {
  TRAE,
  TRAE_BATCH_MODELS_PATH,
  TRAE_CHAT_PATH,
  TRAE_EXCHANGE_PATH,
  TRAE_MAX_OUTPUT_TOKENS,
  TRAE_USER_INFO_PATH,
  type TraeProduct,
} from '../../providers/trae/product.js'
import { claimTraeCredits, fetchTraeQuota } from '../../providers/trae/credits.js'
import { TraeCredentialStore } from './credential-store.js'
import type { ExtensionManifest } from '../../protocol/extension/manifest.js'
import type { ChatChunk } from '../../core/types.js'

const LOGIN_TTL_MS = 10 * 60 * 1000

export interface TraeExtensionOptions {
  port?: number
  dataDir?: string
  secret?: string
  fetcher?: typeof fetch
  /** product override; defaults to the CN product (trae) */
  product?: TraeProduct
  /** overrides the manifest extension id (e.g. 'trae-intl' for the intl image install) */
  extensionId?: string
  apiBase?: string
  now?: () => number
}

/** Build the manifest for a concrete product instance. */
export function traeManifestFor(product: TraeProduct, extensionId?: string): ExtensionManifest {
  // the extension id defaults to the real product id — never a hard-coded literal
  const extId: 'trae' | 'trae-intl' = (extensionId ?? product.id) === 'trae-intl' ? 'trae-intl' : 'trae'
  return {
    apiVersion: '1.0',
    extension: {
      id: extId,
      version: '1.0.0',
      displayName: product.displayName,
      description: `TRAE provider extension (${product.id}) — external-link login, SOLO chat, quota, credits`,
      license: 'MIT',
    },
    runtime: {
      port: 8080,
      healthPath: '/health',
      env: [
        { name: 'LOG_LEVEL', required: false, default: 'info' },
      ],
      volumes: [
        { name: 'state', mountPath: '/data', purpose: 'encrypted credentials + login sessions' },
      ],
      resources: { memory: '256Mi', cpus: '0.5' },
    },
    providers: [
      {
        id: product.id,
        displayName: product.displayName,
        protocol: 'openai-chat',
        capabilities: {
          supportsOAuth: true,
          supportsRefreshToken: true,
          supportsQuota: true,
          supportsCredits: true,
          supportsStreaming: true,
          supportsVision: false,
          supportsToolCall: true,
          supportsMultipleAccounts: true,
          needsCaptcha: false,
          loginMode: 'external-link',
          protocol: 'openai-chat',
        },
        fallbackModels: product.fallbackModels.map((m) => ({
          id: m.id,
          name: m.name,
          capabilities: { vision: false, toolCall: true, streaming: true },
        })),
        actions: [
          {
            id: 'submit-auth-code',
            httpMethod: 'POST',
            title: 'Submit TRAE callback refresh token',
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
}

export const TRAE_MANIFEST = traeManifestFor(TRAE)

export async function startTraeExtension(opts: TraeExtensionOptions = {}): Promise<{
  server: Server
  port: number
  endpointUrl: string
  store: TraeCredentialStore
  manifest: ExtensionManifest
}> {
  const fetcher = opts.fetcher ?? fetch
  const now = opts.now ?? Date.now
  const dataDir = opts.dataDir ?? '/data'
  const secret = opts.secret ?? process.env.GATEWAY_EXTENSION_SECRET ?? 'dev-only-insecure-secret'
  const product = opts.product ?? TRAE
  const manifest = traeManifestFor(product, opts.extensionId ?? product.id)
  const store = new TraeCredentialStore(dataDir, secret)
  const loginSessions = new Map<string, { authUrl: string; startedAt: number }>() // accountId → pending login

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

  /** ExchangeToken — rotates the refresh token and returns a new access token. */
  async function exchangeToken(credential: Partial<TraeCredential>): Promise<Record<string, unknown>> {
    const res = await fetcher(`${product.oauthHost}${TRAE_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': product.userAgent },
      body: JSON.stringify({
        refresh_token: credential.refresh_token ?? '',
        client_id: product.clientId,
        ...(credential.machine_id ? { machine_id: credential.machine_id } : {}),
      }),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const data = typeof body.data === 'object' && body.data !== null ? (body.data as Record<string, unknown>) : body
    if (!res.ok || typeof data.access_token !== 'string') {
      throwUp(
        res.status === 401 || res.status === 403 ? 'AUTH_INVALID' : 'TERMINAL',
        `TRAE ExchangeToken failed (HTTP ${res.status})`,
        res.status,
      )
    }
    return data
  }

  /** Build the credential from an ExchangeToken payload. */
  function buildCredential(data: Record<string, unknown>, base: Partial<TraeCredential>): TraeCredential {
    const access = typeof data.access_token === 'string' ? data.access_token : (base.access_token ?? '')
    const refresh = typeof data.refresh_token === 'string' ? data.refresh_token : (base.refresh_token ?? '')
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : undefined
    const user = typeof data.user === 'object' && data.user !== null ? (data.user as Record<string, unknown>) : {}
    const uid =
      (typeof user.id === 'string' ? user.id : undefined) ??
      (typeof user.user_id === 'string' ? user.user_id : undefined) ??
      (typeof data.uid === 'string' ? data.uid : undefined) ??
      base.uid
    return {
      access_token: access,
      refresh_token: refresh,
      ...(expiresIn ? { expires_at: String(now() + expiresIn * 1000) } : (base.expires_at ? { expires_at: base.expires_at } : {})),
      ...(uid ? { uid } : {}),
      ...(typeof user.nickname === 'string' ? { nickname: user.nickname } : base.nickname ? { nickname: base.nickname } : {}),
      machine_id: base.machine_id ?? '',
      device_id: base.device_id ?? '',
    }
  }

  async function upstreamChatStream(accountId: string, body: Record<string, unknown>): Promise<Response> {
    const credential = store.get(accountId)
    if (!credential?.access_token) throwUp('AUTH_INVALID', 'account has no TRAE access token')
    const model = typeof body.model === 'string' ? body.model : ''
    const sep = model.indexOf('::')
    const payload: Record<string, unknown> = {
      messages: Array.isArray(body.messages) ? body.messages : [],
      model: sep > 0 ? model.slice(sep + 2) : model, // upstream gets the bare id, never the namespace
    }
    if (typeof body.max_tokens === 'number') payload.max_tokens = body.max_tokens
    else payload.max_tokens = TRAE_MAX_OUTPUT_TOKENS
    if (typeof body.temperature === 'number') payload.temperature = body.temperature
    if (Array.isArray(body.tools) && body.tools.length > 0) payload.tools = body.tools
    const soloBody = transformToSOLOBody(payload, product.function)
    const res = await fetcher(`${product.agentHost}${TRAE_CHAT_PATH}`, {
      method: 'POST',
      headers: traeSOLOHeaders(credential, product, true),
      body: JSON.stringify(soloBody),
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      const c = classify(res.status, `TRAE chat failed (HTTP ${res.status})${text ? `: ${text}` : ''}`)
      throwUp(c.kind, c.message, res.status)
    }
    return res
  }

  async function* chatChunks(accountId: string, body: Record<string, unknown>): AsyncGenerator<ChatChunk> {
    const upstream = await upstreamChatStream(accountId, body)
    for await (const event of parseTraeSoloEvents(upstream.body as unknown as AsyncIterable<Uint8Array>)) {
      if (event.event === 'output') {
        const text = typeof event.data.response === 'string' ? event.data.response : ''
        const reasoning = typeof event.data.reasoning_content === 'string' ? event.data.reasoning_content : undefined
        const chunk: ChatChunk = { text }
        if (reasoning !== undefined && reasoning !== '') chunk.reasoning = reasoning
        if (text !== '' || chunk.reasoning !== undefined) yield chunk
      } else if (event.event === 'token_usage') {
        yield {
          text: '',
          usage: {
            promptTokens: typeof event.data.prompt_tokens === 'number' ? event.data.prompt_tokens : undefined,
            completionTokens: typeof event.data.completion_tokens === 'number' ? event.data.completion_tokens : undefined,
          },
        }
      } else if (event.event === 'done') {
        const reason = typeof event.data.finish_reason === 'string' ? event.data.finish_reason : 'stop'
        yield { text: '', finishReason: reason as ChatChunk['finishReason'] }
      } else if (event.event === 'error') {
        const message = typeof event.data.message === 'string' ? event.data.message : 'TRAE upstream error'
        throw new (await import('../../core/errors/upstream-error.js')).UpstreamError({ kind: 'TERMINAL', message })
      }
    }
  }

  async function modelsFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    let remote: Array<{ id: string; name: string }> = []
    if (credential?.access_token) {
      const res = await fetcher(`${product.agentHost}${TRAE_BATCH_MODELS_PATH}`, {
        method: 'POST',
        headers: traeSOLOHeaders(credential, product, false),
        body: '{}',
      })
      if (res.ok) remote = parseTraeBatchModelList(await res.json().catch(() => null), product.channels)
    }
    const source = remote.length > 0
      ? remote.map((m) => ({ id: m.id, name: m.name }))
      : product.fallbackModels.map((m) => ({ ...m }))
    return {
      models: source.map((m) => ({
        id: m.id,
        name: m.name,
        capabilities: { vision: false, toolCall: true, streaming: true },
      })),
    }
  }

  async function quotaFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    if (!credential?.uid) return { accountId, resources: [], checkedAt: new Date().toISOString(), source: 'authoritative' }
    const quota = await fetchTraeQuota({ product, credential, uid: credential.uid, fetcher })
    return {
      accountId,
      resources: [{
        id: 'credits',
        status: quota.known ? (quota.remaining !== null && quota.remaining <= 0 ? 'exhausted' : 'ok') : 'unknown',
        remaining: quota.remaining,
        total: quota.total,
        unit: 'credits',
        resetAt: quota.resetAt ?? null,
      }],
      checkedAt: new Date().toISOString(),
      source: 'authoritative',
    }
  }

  // -- protocol projection ---------------------------------------------------

  function accountsProjection(): unknown {
    return {
      accounts: store.list().map((rec) => {
        const expiresAt = rec.credential.expires_at ? Number(rec.credential.expires_at) : undefined
        const expired = expiresAt !== undefined && now() >= expiresAt
        return {
          accountId: rec.accountId,
          providerId: product.id,
          displayName: rec.displayName ?? rec.accountId,
          status: !rec.enabled ? 'disabled' : expired ? (rec.credential.refresh_token ? 'token_expired' : 'auth_failed') : 'active',
          manualAction: null,
          quota: null, // fetched on demand via /quota
          lastError: null,
          lastSuccessAt: new Date(rec.updatedAt).toISOString(),
          lastFailureAt: null,
          metadata: { refreshable: Boolean(rec.credential.refresh_token) },
        }
      }),
    }
  }

  function chunkToSseEvent(chunk: ChatChunk): string {
    return `event: chunk\ndata: ${JSON.stringify(chunk)}\n\n`
  }

  async function handleChatStream(accountId: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let done = false
    try {
      for await (const chunk of chatChunks(accountId, body)) {
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

    if (req.method === 'GET' && path === '/manifest') return send(res, 200, manifest)
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { status: 'healthy', version: manifest.extension.version, accounts: { total: store.list().length, usable: store.list().filter((r) => r.enabled).length } })
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
        : `${product.id}-${randomUUID().slice(0, 8)}`
      if (store.has(requested) || loginSessions.has(requested)) {
        return send(res, 409, { error: { kind: 'TERMINAL', message: `account ${requested} already exists` } })
      }
      // TRAE forces a loopback callback; the operator completes login in a
      // browser and pastes the callback refresh token back through the auth action.
      const state = `${requested}-${now()}`
      const authUrl = `${product.consoleHost}/authorization?client_id=${product.clientId}&state=${encodeURIComponent(state)}`
      loginSessions.set(requested, { authUrl, startedAt: now() })
      return send(res, 201, {
        accountId: requested,
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
        const pending = loginSessions.get(accountId)
        const rec = store.list().find((r) => r.accountId === accountId)
        if (!rec && !pending) return send(res, 404, { error: { kind: 'TERMINAL', message: `unknown account ${accountId}` } })
        if (pending && now() - pending.startedAt > LOGIN_TTL_MS) {
          loginSessions.delete(accountId)
        }
        const accounts = (accountsProjection() as { accounts: Array<{ accountId: string }> }).accounts
        const projected = accounts.find((a) => a.accountId === accountId)
        if (projected) return send(res, 200, { account: projected })
        return send(res, 200, {
          account: {
            accountId,
            providerId: product.id,
            displayName: accountId,
            status: 'needs_manual_action',
            manualAction: 'submit-auth-code',
            quota: null,
            lastError: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            metadata: { loginUrl: pending?.authUrl ?? '' },
          },
        })
      }
      if (op === 'quota') return send(res, 200, await quotaFor(accountId))
      if (op === 'refresh') {
        const credential = store.get(accountId)
        if (!credential) return send(res, 200, { status: 'auth_failed', refreshed: false, error: 'no credential' })
        if (!credential.refresh_token) return send(res, 200, { status: 'auth_failed', refreshed: false, error: 'not refreshable' })
        // ExchangeToken rotates the refresh token; identity fields stay untouched.
        const data = await exchangeToken(credential)
        store.put(accountId, buildCredential(data, credential), store.displayName(accountId))
        const updated = store.get(accountId)
        return send(res, 200, {
          status: 'active',
          refreshed: true,
          expiresAt: updated?.expires_at ? Number(updated.expires_at) : null,
        })
      }
      if (op === 'claim') {
        const credential = store.get(accountId)
        if (!credential?.uid) return send(res, 200, { outcome: { kind: 'needs_auth', message: 'credential has no uid' } })
        const outcome = await claimTraeCredits({ product, credential, uid: credential.uid, fetcher })
        return send(res, 200, { outcome })
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
      // Either an exchanged credential blob or a refresh token from the
      // callback URL. A fresh device identity is generated once here and then
      // persisted; it is never regenerated on refresh.
      if (typeof payload.access_token === 'string' && payload.access_token.length > 0) {
        const credential = payload as unknown as TraeCredential
        const target = accountId || `${product.id}-${randomUUID().slice(0, 8)}`
        store.put(target, credential, credential.nickname ?? null)
        return send(res, 200, { result: { accepted: true, account_id: target, display_name: credential.nickname ?? null } })
      }
      const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined
      if (!refreshToken) {
        return send(res, 200, { result: { accepted: false, error: 'expects a TRAE credential blob or { refresh_token }' } })
      }
      if (accountId && !loginSessions.has(accountId)) {
        return send(res, 404, { error: { kind: 'TERMINAL', message: `no pending login for account ${accountId}` } })
      }
      const device = newTraeDeviceIdentity()
      const exchange = await exchangeToken({ refresh_token: refreshToken, machine_id: device.machine_id, device_id: device.device_id })
      const credential = buildCredential(exchange, { ...device, refresh_token: refreshToken, expires_at: String(now() + 3_600_000) })
      const target = accountId || `${product.id}-${randomUUID().slice(0, 8)}`
      store.put(target, credential, credential.nickname ?? null)
      loginSessions.delete(target)
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
        for await (const chunk of chatChunks(accountId, body)) {
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
      resolve({ server, port, endpointUrl: `http://127.0.0.1:${port}`, store, manifest })
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

/** Local runtime boot contract: run(port, env). The product is fixed at image
 *  build/install time via TRAE_PRODUCT (trae | trae-intl). */
export async function run(port: number, env: Record<string, string> = {}): Promise<void> {
  const product = env.TRAE_PRODUCT === 'trae-intl'
    ? (await import('../../providers/trae/product.js')).TRAE_INTL
    : TRAE
  await startTraeExtension({ port, secret: env.GATEWAY_EXTENSION_SECRET, product })
  await new Promise(() => undefined)
}
