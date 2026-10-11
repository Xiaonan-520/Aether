/**
 * Loomy Extension (RFC v2 §24 — provider migration into an extension).
 *
 * Full Loomy provider surface: SMS login (send code → import mcode), session
 * credentials (no refresh — re-login on expiry), model discovery, quota and
 * daily-credit claim, OpenAI-compatible chat (JSON + SSE), upstream error
 * mapping. Reuses the pure protocol primitives from `src/providers/loomy/*`.
 *
 * Credential boundary: credentials live in this extension's encrypted store;
 * protocol payloads carry NO credential material; account ids are
 * Core-allocated opaque strings (§10.3).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  isLoomyExpired,
  loomyBusinessHeaders,
  loomyChatHeaders,
  loomyCheckCodeBody,
  loomySendCodeBody,
  parseLoomyEnvelope,
  parseLoomyModels,
  type LoomyCredential,
} from '../../providers/loomy/protocol.js'
import { signLoomyRequest } from '../../providers/loomy/sign.js'
import {
  LOOMY,
  LOOMY_CHAT_PATH,
  LOOMY_CHECK_CODE_PATH,
  LOOMY_FIRST_LOGIN_PATH,
  LOOMY_MODELS_PATH,
  LOOMY_POINTS_RECORDS_PATH,
  LOOMY_SEND_CODE_PATH,
} from '../../providers/loomy/product.js'
import { claimLoomyDailyQuota, fetchLoomyQuota } from '../../providers/loomy/credits.js'
import { decodeSseStream } from '../../protocol/openai/sse.js'
import { LoomyCredentialStore } from './credential-store.js'
import type { ExtensionManifest } from '../../protocol/extension/manifest.js'
import type { ChatChunk } from '../../core/types.js'

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

const LOGIN_TTL_MS = 5 * 60 * 1000

export const LOOMY_MANIFEST: ExtensionManifest = {
  apiVersion: '1.0',
  extension: {
    id: 'loomy',
    version: '1.0.0',
    displayName: 'Loomy (讯飞)',
    description: 'Loomy (iFlytek) provider extension — SMS login, chat, quota, daily credit',
    license: 'MIT',
  },
  runtime: {
    port: 8080,
    healthPath: '/health',
    env: [
      { name: 'LOG_LEVEL', required: false, default: 'info' },
      { name: 'LOOMY_API_BASE', required: false, default: '' },
    ],
    volumes: [
      { name: 'state', mountPath: '/data', purpose: 'encrypted credentials + login sessions' },
    ],
    resources: { memory: '256Mi', cpus: '0.5' },
  },
  providers: [
    {
      id: 'loomy',
      displayName: LOOMY.displayName,
      protocol: 'openai-chat',
      capabilities: {
        supportsOAuth: true,
        supportsRefreshToken: false, // sessions expire; re-login required
        supportsQuota: true,
        supportsCredits: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsToolCall: false,
        supportsMultipleAccounts: true,
        needsCaptcha: false,
        loginMode: 'sms',
        protocol: 'openai-chat',
      },
      fallbackModels: LOOMY.fallbackModels.map((m) => ({
        id: m.id,
        name: m.name,
        capabilities: { vision: false, toolCall: false, streaming: true },
      })),
      actions: [
        {
          id: 'submit-auth-code',
          httpMethod: 'POST',
          title: 'Submit SMS code or session',
          mode: 'write',
          sideEffects: 'one-shot',
          ui: 'form',
          inputSchema: {
            type: 'object',
            properties: { mcode: { type: 'string' }, code: { type: 'string' }, account_id: { type: 'string' } },
          },
          outputSchema: { type: 'object' },
        },
        {
          id: 'begin-sms-login',
          httpMethod: 'POST',
          title: 'Send SMS login code',
          mode: 'write',
          sideEffects: 'one-shot',
          ui: 'form',
          inputSchema: {
            type: 'object',
            properties: { phone: { type: 'string' }, account_id: { type: 'string' } },
            required: ['phone'],
          },
          outputSchema: { type: 'object' },
        },
      ],
      authAction: 'submit-auth-code',
    },
  ],
}

interface SmsSession {
  phone: string
  msgid?: string
  credential?: LoomyCredential
  startedAt: number
}

export interface LoomyExtensionOptions {
  port?: number
  dataDir?: string
  secret?: string
  fetcher?: typeof fetch
  apiBase?: string
  now?: () => number
}

export async function startLoomyExtension(opts: LoomyExtensionOptions = {}): Promise<{
  server: Server
  port: number
  endpointUrl: string
  store: LoomyCredentialStore
}> {
  const fetcher = opts.fetcher ?? fetch
  const now = opts.now ?? Date.now
  const dataDir = opts.dataDir ?? '/data'
  const secret = opts.secret ?? process.env.GATEWAY_EXTENSION_SECRET ?? 'dev-only-insecure-secret'
  const apiBase = opts.apiBase ?? process.env.LOOMY_API_BASE ?? ''
  const PRODUCT = apiBase ? { ...LOOMY, apiBase } : LOOMY
  const store = new LoomyCredentialStore(dataDir, secret)
  const sessions = new Map<string, SmsSession>() // accountId → pending SMS login

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

  /** Signed POST to the iFlytek account host (login endpoints). */
  async function postAccount(path: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${PRODUCT.accountBase}${path}`
    const payload = JSON.stringify(body)
    const signed = signLoomyRequest({
      accessKeyId: PRODUCT.accessKeyId,
      accessKeySecret: PRODUCT.accessKeySecret,
      method: 'POST',
      path,
      body: payload,
      contentType: 'application/json',
    })
    const res = await fetcher(url, {
      method: 'POST',
      headers: { ...signed, 'Content-Type': 'application/json' },
      body: payload,
    })
    return res.json().catch(() => null)
  }

  // -- upstream operations ---------------------------------------------------

  async function upstreamChatStream(accountId: string, body: Record<string, unknown>): Promise<Response> {
    const credential = store.get(accountId)
    if (!credential?.access_token) throwUp('AUTH_INVALID', 'account has no Loomy session')
    const model = typeof body.model === 'string' ? body.model : ''
    const sep = model.indexOf('::')
    const payload: Record<string, unknown> = {
      model: sep > 0 ? model.slice(sep + 2) : model, // upstream gets the bare id, never the namespace
      messages: Array.isArray(body.messages) ? body.messages : [],
      stream: true,
    }
    if (typeof body.max_tokens === 'number') payload.max_tokens = body.max_tokens
    if (typeof body.temperature === 'number') payload.temperature = body.temperature
    const res = await fetcher(`${PRODUCT.apiBase}${LOOMY_CHAT_PATH}`, {
      method: 'POST',
      headers: loomyChatHeaders(credential.access_token),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      const c = classify(res.status, `Loomy chat failed (HTTP ${res.status})${text ? `: ${text}` : ''}`)
      throwUp(c.kind, c.message, res.status)
    }
    return res
  }

  async function modelsFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    let remote: Array<{ id: string; name: string }> = []
    if (credential) {
      const res = await fetcher(`${PRODUCT.apiBase}${LOOMY_MODELS_PATH}`, {
        headers: loomyBusinessHeaders(credential.access_token),
      })
      if (res.ok) remote = parseLoomyModels(await res.json().catch(() => null))
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
    const quota = await fetchLoomyQuota({ product: PRODUCT, credential, fetcher })
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
        const expired = isLoomyExpired(rec.credential)
        return {
          accountId: rec.accountId,
          providerId: 'loomy',
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

    if (req.method === 'GET' && path === '/manifest') return send(res, 200, LOOMY_MANIFEST)
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { status: 'healthy', version: LOOMY_MANIFEST.extension.version, accounts: { total: store.list().length, usable: store.list().filter((r) => r.enabled).length } })
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
        : `loomy-${randomUUID().slice(0, 8)}`
      if (store.has(requested) || sessions.has(requested)) {
        return send(res, 409, { error: { kind: 'TERMINAL', message: `account ${requested} already exists` } })
      }
      // no phone supplied → the login begins at needsManual (SMS code entry)
      return send(res, 201, {
        accountId: requested,
        status: 'pending',
        needsManual: true,
        manualAction: 'begin-sms-login',
        pollInterval: 2,
      })
    }

    const acctMatch = /^\/v1\/accounts\/([A-Za-z0-9-]+)(?:\/(quota|refresh|claim|enable|disable))?$/.exec(path)
    if (acctMatch) {
      const [, accountId, op] = acctMatch
      if (!op) {
        const session = sessions.get(accountId)
        const rec = store.list().find((r) => r.accountId === accountId)
        if (!rec && !session) return send(res, 404, { error: { kind: 'TERMINAL', message: `unknown account ${accountId}` } })
        if (session) {
          // SMS flow: pending until the code is imported via the auth action
          if (session.credential) {
            const credential = session.credential
            store.put(accountId, credential, credential.nickname ?? null)
            sessions.delete(accountId)
          } else if (now() - session.startedAt > LOGIN_TTL_MS) {
            sessions.delete(accountId)
            return send(res, 200, { account: { accountId, providerId: 'loomy', displayName: accountId, status: 'auth_failed', manualAction: null, quota: null, lastError: 'login timed out', lastSuccessAt: null, lastFailureAt: new Date().toISOString(), metadata: {} } })
          }
        }
        const accounts = (accountsProjection() as { accounts: Array<{ accountId: string }> }).accounts
        const projected = accounts.find((a) => a.accountId === accountId)
        if (projected) return send(res, 200, { account: projected })
        const live = sessions.get(accountId)
        return send(res, 200, {
          account: {
            accountId,
            providerId: 'loomy',
            displayName: accountId,
            status: 'needs_manual_action',
            manualAction: 'submit-auth-code',
            quota: null,
            lastError: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            metadata: { awaiting: live?.msgid ? 'sms-code' : 'phone-number' },
          },
        })
      }
      if (op === 'quota') return send(res, 200, await quotaFor(accountId))
      if (op === 'refresh') {
        // Loomy has no refresh endpoint: an explicit, honest not-refreshable
        return send(res, 200, { status: store.has(accountId) ? 'auth_failed' : 'unknown', refreshed: false, error: 'Loomy has no refresh endpoint; re-login (SMS) is required when the session expires' })
      }
      if (op === 'claim') {
        const credential = store.get(accountId)
        if (!credential) return send(res, 200, { outcome: { kind: 'needs_auth', message: 'no credential' } })
        const outcome = await claimLoomyDailyQuota({ product: PRODUCT, credential, fetcher })
        return send(res, 200, { outcome })
      }
      if (op === 'enable' || op === 'disable') {
        const accepted = store.setEnabled(accountId, op === 'enable')
        const rec = store.list().find((r) => r.accountId === accountId)
        const status = !accepted ? 'unknown' : !rec!.enabled ? 'disabled' : 'active'
        return send(res, 200, { accountId, accepted, status })
      }
    }

    if (req.method === 'POST' && path === '/v1/actions/begin-sms-login') {
      const body = await readJson(req) as { payload?: { phone?: unknown; account_id?: unknown } } | undefined
      const payload = (body?.payload ?? {}) as Record<string, unknown>
      const accountId = typeof payload.account_id === 'string' ? payload.account_id : ''
      const phone = typeof payload.phone === 'string' ? payload.phone.trim() : ''
      if (phone === '') return send(res, 400, { error: { kind: 'TERMINAL', message: 'missing "phone"' } })
      const envelope = parseLoomyEnvelope(await postAccount(LOOMY_SEND_CODE_PATH, loomySendCodeBody(phone)))
      if (!envelope.ok) {
        return send(res, 200, { result: { accepted: false, error: `sendMsgCode failed (code ${envelope.code})` } })
      }
      const msgid = typeof envelope.data.msgid === 'string' ? envelope.data.msgid : undefined
      sessions.set(accountId, { phone, ...(msgid ? { msgid } : {}), startedAt: now() })
      return send(res, 200, { result: { accepted: true, account_id: accountId, needsManual: true, manualAction: 'submit-auth-code' } })
    }

    if (req.method === 'POST' && path === '/v1/actions/submit-auth-code') {
      const body = await readJson(req) as { payload?: Record<string, unknown> } | undefined
      const payload = (body?.payload ?? {}) as Record<string, unknown>
      const accountId = typeof payload.account_id === 'string' ? payload.account_id : ''
      // ready session blob
      if (typeof payload.access_token === 'string' && payload.access_token.length > 0) {
        const credential = payload as unknown as LoomyCredential
        const target = accountId || `loomy-${randomUUID().slice(0, 8)}`
        store.put(target, credential, credential.nickname ?? null)
        return send(res, 200, { result: { accepted: true, account_id: target, display_name: credential.nickname ?? null } })
      }
      const mcode = typeof payload.mcode === 'string' ? payload.mcode : typeof payload.code === 'string' ? payload.code : undefined
      if (!mcode) {
        return send(res, 400, { error: { kind: 'TERMINAL', message: 'missing "mcode"' } })
      }
      const session = accountId ? sessions.get(accountId) : undefined
      if (!session?.msgid) {
        return send(res, 404, { error: { kind: 'TERMINAL', message: 'no pending SMS login; send a code first (begin-sms-login)' } })
      }
      const envelope = parseLoomyEnvelope(await postAccount(LOOMY_CHECK_CODE_PATH, loomyCheckCodeBody(session.phone, mcode, session.msgid)))
      if (!envelope.ok) {
        const kind = envelope.code === '100002' ? 'AUTH_INVALID' : 'NEEDS_MANUAL'
        return send(res, 200, { result: { accepted: false, error: `checkCode failed (code ${envelope.code})` }, error: { kind } })
      }
      const sessionValue =
        typeof envelope.data.session === 'string'
          ? envelope.data.session
          : typeof envelope.data.token === 'string'
            ? envelope.data.token
            : undefined
      if (!sessionValue) {
        return send(res, 200, { result: { accepted: false, error: 'checkCode response carried no session' } })
      }
      const credential: LoomyCredential = {
        access_token: sessionValue,
        expires_at: String(now() + 14 * 24 * 3_600_000),
        phone: session.phone,
        ...(typeof envelope.data.uid === 'string' ? { uid: envelope.data.uid } : {}),
        ...(typeof envelope.data.nickname === 'string' ? { nickname: envelope.data.nickname } : {}),
      }
      store.put(accountId, credential, credential.nickname ?? null)
      sessions.delete(accountId)
      return send(res, 200, { result: { accepted: true, account_id: accountId, display_name: credential.nickname ?? null } })
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
  await startLoomyExtension({ port, secret: env.GATEWAY_EXTENSION_SECRET })
  await new Promise(() => undefined)
}
