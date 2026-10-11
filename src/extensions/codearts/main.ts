/**
 * CodeArts Extension (RFC v2 §24 — provider migration into an extension).
 *
 * Full CodeArts provider surface: external-link login with AK/SK or
 * credential-ticket import, HMAC-SHA256-signed chat (SSE) and signed GETs,
 * model discovery, package quota, credit claim, upstream error mapping.
 * Reuses the pure protocol primitives from `src/providers/codearts/*`.
 *
 * Credential boundary: temporary AK/SK credentials live in this extension's
 * encrypted store; protocol payloads carry NO credential material; account
 * ids are Core-allocated opaque strings (§10.3).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  isCodeArtsBenefitModel,
  isCodeArtsExpired,
  parseCodeArtsCredential,
  parseCodeArtsModels,
  type CodeArtsCredential,
} from '../../providers/codearts/protocol.js'
import { signHuaweiRequest } from '../../providers/codearts/sign.js'
import {
  CODEARTS,
  CODEARTS_CHAT_PATH,
  CODEARTS_SNAP_MODEL_BUILTIN_PATH,
} from '../../providers/codearts/product.js'
import { claimCodeArtsCredits } from '../../providers/codearts/credits.js'
import { decodeSseStream } from '../../protocol/openai/sse.js'
import { CodeArtsCredentialStore } from './credential-store.js'
import type { ExtensionManifest } from '../../protocol/extension/manifest.js'
import type { ChatChunk } from '../../core/types.js'

const LOGIN_TTL_MS = 10 * 60 * 1000

export const CODEARTS_MANIFEST: ExtensionManifest = {
  apiVersion: '1.0',
  extension: {
    id: 'codearts',
    version: '1.0.0',
    displayName: 'CodeArts (华为云)',
    description: 'CodeArts Snap provider extension — temporary AK/SK, HMAC-signed chat, package quota, credit claim',
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
      id: 'codearts',
      displayName: CODEARTS.displayName,
      protocol: 'openai-chat',
      capabilities: {
        supportsOAuth: true,
        supportsRefreshToken: false, // temporary AK/SK only — no refresh endpoint
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
      fallbackModels: CODEARTS.fallbackModels.map((m) => ({
        id: m.id,
        name: m.name,
        capabilities: { vision: false, toolCall: true, streaming: true },
      })),
      actions: [
        {
          id: 'submit-auth-code',
          httpMethod: 'POST',
          title: 'Submit CodeArts AK/SK or credential ticket',
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

export interface CodeArtsExtensionOptions {
  port?: number
  dataDir?: string
  secret?: string
  fetcher?: typeof fetch
  now?: () => number
}

export async function startCodeArtsExtension(opts: CodeArtsExtensionOptions = {}): Promise<{
  server: Server
  port: number
  endpointUrl: string
  store: CodeArtsCredentialStore
}> {
  const fetcher = opts.fetcher ?? fetch
  const now = opts.now ?? Date.now
  const dataDir = opts.dataDir ?? '/data'
  const secret = opts.secret ?? process.env.GATEWAY_EXTENSION_SECRET ?? 'dev-only-insecure-secret'
  const PRODUCT = CODEARTS
  const store = new CodeArtsCredentialStore(dataDir, secret)
  const loginSessions = new Map<string, { authUrl: string; startedAt: number }>()

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

  function bareOf(model: string): string {
    const sep = model.indexOf('::')
    return sep > 0 ? model.slice(sep + 2) : model
  }

  /** Signed GET against the snap host (shared by models/health/quota). */
  async function signedGet(credential: CodeArtsCredential, path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
    const url = `${PRODUCT.snapBase}${path}`
    const signed = signHuaweiRequest(
      credential.access_key_id,
      credential.secret_access_key,
      credential.security_token,
      'GET',
      url,
      new Uint8Array(),
      { 'agent-type': PRODUCT.agentTypeHeader },
    )
    const res = await fetcher(url, { method: 'GET', headers: { ...signed.headers, 'user-agent': PRODUCT.userAgent } })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { ok: res.ok, status: res.status, body }
  }

  /** Sign and send the chat request; a benefit model needs `maas_type`. */
  async function sendChat(credential: CodeArtsCredential, body: Record<string, unknown>): Promise<Response> {
    const url = `${PRODUCT.chatBase}${CODEARTS_CHAT_PATH}`
    const payload = new TextEncoder().encode(JSON.stringify(body))
    const extra: Record<string, string> = { 'agent-type': PRODUCT.agentTypeHeader }
    if (isCodeArtsBenefitModel(String(body.model ?? ''))) extra.maas_type = 'benefit'
    const signed = signHuaweiRequest(
      credential.access_key_id,
      credential.secret_access_key,
      credential.security_token,
      'POST',
      url,
      payload,
      extra,
    )
    return fetcher(url, {
      method: 'POST',
      headers: { ...signed.headers, 'user-agent': PRODUCT.userAgent, accept: 'text/event-stream' },
      body: payload,
    })
  }

  async function* chatChunks(accountId: string, body: Record<string, unknown>): AsyncGenerator<ChatChunk> {
    const credential = store.get(accountId)
    if (!credential?.access_key_id) throwUp('AUTH_INVALID', 'account has no CodeArts credential')
    if (isCodeArtsExpired(credential)) {
      throwUp('TOKEN_EXPIRED', 'CodeArts credential expired; re-login required')
    }
    const model = typeof body.model === 'string' ? body.model : ''
    const payload: Record<string, unknown> = {
      model: bareOf(model), // upstream gets the bare id, never the namespace
      messages: Array.isArray(body.messages) ? body.messages : [],
      stream: true,
    }
    if (typeof body.max_tokens === 'number') payload.max_tokens = body.max_tokens
    if (typeof body.temperature === 'number') payload.temperature = body.temperature
    if (Array.isArray(body.tools) && body.tools.length > 0) payload.tools = body.tools
    const res = await sendChat(credential, payload)
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      const c = classify(res.status, `CodeArts chat failed (HTTP ${res.status}) ${text}`)
      throwUp(c.kind, c.message, res.status)
    }
    for await (const chunk of decodeSseStream(res.body as unknown as AsyncIterable<Uint8Array>)) {
      if (chunk.text === '' && chunk.reasoning === undefined && chunk.finishReason == null && !chunk.usage) continue
      yield chunk
    }
  }

  async function modelsFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    let remote: Array<{ id: string; name: string }> = []
    if (credential) {
      const res = await signedGet(credential, CODEARTS_SNAP_MODEL_BUILTIN_PATH)
      if (res.ok) remote = parseCodeArtsModels(res.body)
    }
    const source = remote.length > 0 ? remote : PRODUCT.fallbackModels.map((m) => ({ ...m }))
    return {
      models: source.map((m) => ({
        id: m.id,
        name: m.name,
        capabilities: { vision: false, toolCall: true, streaming: true },
        metadata: isCodeArtsBenefitModel(m.id) ? { benefit: true } : {},
      })),
    }
  }

  async function quotaFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    if (!credential) return { accountId, resources: [], checkedAt: new Date().toISOString(), source: 'authoritative' }
    // package info exposes the account's entitlement
    const res = await signedGet(credential, '/snap-manager/v1/statistics/plugin')
    if (!res.ok || res.body === null) {
      return { accountId, resources: [], checkedAt: new Date().toISOString(), source: 'authoritative' }
    }
    const record = res.body as Record<string, unknown>
    const data = typeof record.data === 'object' && record.data !== null ? (record.data as Record<string, unknown>) : record
    const pick = (key: string): number | null => (typeof data[key] === 'number' ? (data[key] as number) : null)
    const remaining = pick('remaining') ?? pick('balance') ?? pick('credits')
    return {
      accountId,
      resources: [{
        id: 'credits',
        status: remaining === null ? 'unknown' : remaining <= 0 ? 'exhausted' : 'ok',
        remaining,
        total: pick('total') ?? pick('totalCredits'),
        unit: 'credits',
        resetAt: null,
      }],
      checkedAt: new Date().toISOString(),
      source: 'authoritative',
    }
  }

  // -- protocol projection ---------------------------------------------------

  function accountsProjection(): unknown {
    return {
      accounts: store.list().map((rec) => {
        const expired = isCodeArtsExpired(rec.credential)
        return {
          accountId: rec.accountId,
          providerId: 'codearts',
          displayName: rec.displayName ?? rec.accountId,
          status: !rec.enabled ? 'disabled' : expired ? 'auth_failed' : 'active',
          manualAction: null,
          quota: null, // fetched on demand via /quota
          lastError: null,
          lastSuccessAt: new Date(rec.updatedAt).toISOString(),
          lastFailureAt: null,
          metadata: { refreshable: false },
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

    if (req.method === 'GET' && path === '/manifest') return send(res, 200, CODEARTS_MANIFEST)
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { status: 'healthy', version: CODEARTS_MANIFEST.extension.version, accounts: { total: store.list().length, usable: store.list().filter((r) => r.enabled).length } })
    }

    if (!verifyAuth(req)) return send(res, 401, { error: { kind: 'AUTH_INVALID', message: 'bad extension token' } })

    if (req.method === 'GET' && path === '/v1/models') {
      const accountId = url.searchParams.get('account_id') ?? store.list()[0]?.accountId
      return send(res, 200, await modelsFor(accountId ?? ''))
    }

    if (req.method === 'GET' && path === '/v1/accounts') return send(res, 200, accountsProjection())

    if (req.method === 'POST' && path === '/v1/accounts') {
      const body = await readJson(req) as Record<string, unknown> | undefined
      if (body && ['access_key_id', 'secret_access_key', 'access_token', 'password', 'api_key', 'secret'].some((k) => k in (body as object))) {
        return send(res, 400, { error: { kind: 'PROTOCOL_VIOLATION', message: 'credential fields are forbidden in account creation (RFC §10.3)' } })
      }
      const requested = typeof body?.accountId === 'string' && body.accountId.length > 0
        ? body.accountId
        : `codearts-${randomUUID().slice(0, 8)}`
      if (store.has(requested) || loginSessions.has(requested)) {
        return send(res, 409, { error: { kind: 'TERMINAL', message: `account ${requested} already exists` } })
      }
      const authUrl = `${PRODUCT.consoleBase}/portal/login`
      loginSessions.set(requested, { authUrl, startedAt: now() })
      return send(res, 201, {
        accountId: requested,
        status: 'pending',
        authorizationUrl: authUrl,
        expiresIn: Math.floor(LOGIN_TTL_MS / 1000),
        pollInterval: 3,
      })
    }

    const acctMatch = /^\/v1\/accounts\/([A-Za-z0-9-]+)(?:\/(quota|refresh|claim|enable|disable))?$/.exec(path)
    if (acctMatch) {
      const [, accountId, op] = acctMatch
      if (!op) {
        const pending = loginSessions.get(accountId)
        const rec = store.list().find((r) => r.accountId === accountId)
        if (!rec && !pending) return send(res, 404, { error: { kind: 'TERMINAL', message: `unknown account ${accountId}` } })
        if (pending && now() - pending.startedAt > LOGIN_TTL_MS) loginSessions.delete(accountId)
        const accounts = (accountsProjection() as { accounts: Array<{ accountId: string }> }).accounts
        const projected = accounts.find((a) => a.accountId === accountId)
        if (projected) return send(res, 200, { account: projected })
        return send(res, 200, {
          account: {
            accountId,
            providerId: 'codearts',
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
        // CodeArts has no refresh endpoint; the AK/SK are temporary. Honest answer.
        return send(res, 200, { status: store.has(accountId) ? 'auth_failed' : 'unknown', refreshed: false, error: 'CodeArts credentials are temporary AK/SK; re-login is required when they expire' })
      }
      if (op === 'claim') {
        const credential = store.get(accountId)
        if (!credential) return send(res, 200, { outcome: { kind: 'needs_auth', message: 'no credential' } })
        const outcome = await claimCodeArtsCredits({ product: PRODUCT, credential, fetcher })
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
      // Either a ready AK/SK blob, or a ticket response to parse.
      const credential =
        typeof payload.access_key_id === 'string' && payload.access_key_id.length > 0
          ? (payload as unknown as CodeArtsCredential)
          : parseCodeArtsCredential(payload)
      if (!credential) {
        return send(res, 200, { result: { accepted: false, error: 'expects a CodeArts AK/SK credential or a credential-ticket response' } })
      }
      const target = accountId || `codearts-${randomUUID().slice(0, 8)}`
      store.put(target, credential, null)
      loginSessions.delete(target)
      return send(res, 200, { result: { accepted: true, account_id: target, display_name: null } })
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
  await startCodeArtsExtension({ port, secret: env.GATEWAY_EXTENSION_SECRET })
  await new Promise(() => undefined)
}
