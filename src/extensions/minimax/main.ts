/**
 * MiniMax Code Extension (China + International).
 *
 * One image serves both products; the runtime picks the site from
 * MINIMAX_PRODUCT (minimax | minimaxintl) — the two sites differ only in six
 * fields (id, displayName, accountHost, apiHost, region, credential ref).
 *
 * Upstream speaks **Anthropic Messages** (`POST {apiHost}/mavis/api/v1/llm/v1/messages`),
 * so this extension translates:
 *
 *   OpenAI-compatible request  →  Anthropic Messages payload  (protocol.ts)
 *   Anthropic SSE events       →  gateway ChatChunk stream   (protocol.ts)
 *
 * Login is the standard OAuth device-code grant (RFC 8628) with PKCE S256.
 * No captcha, no SMS, no proprietary WASM.
 *
 * Empty-frame discipline (the lesson from the 11128/empty-delta work): the
 * upstream envelope carries `thinking` blocks and signature deltas on most
 * frames. Only NON-EMPTY increments are emitted, `signature_delta` is dropped
 * (it is a signature, not text), and a frame with no payload produces no
 * downstream chunk at all.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { join } from 'node:path'
import {
  MINIMAX,
  MINIMAX_INTL,
  MINIMAX_DEVICE_CODE_PATH,
  MINIMAX_TOKEN_PATH,
  buildMinimaxPayload,
  buildPollBody,
  buildRefreshBody,
  isExpired,
  isRefreshable,
  parseMinimaxEvent,
  type MinimaxChunk,
  type MinimaxCredential,
  type MinimaxProduct,
  type OpenAiMessage,
} from '../../providers/minimax/protocol.js'
import type { ExtensionManifest } from '../../protocol/extension/manifest.js'
import type { ChatChunk } from '../../core/types.js'

// ---------------------------------------------------------------------------
// Credential store (same trust model as the other extensions)
// ---------------------------------------------------------------------------

interface StoredRecord {
  accountId: string
  credential: MinimaxCredential
  displayName: string | null
  enabled: boolean
  updatedAt: number
}

class MinimaxCredentialStore {
  private readonly key: Buffer
  private readonly file: string
  private records = new Map<string, StoredRecord>()

  constructor(dataDir: string, secret: string) {
    this.key = scryptSync(secret, 'gw-ext-minimax-salt-v1', 32)
    this.file = join(dataDir, 'minimax-credentials.json.enc')
    mkdirSync(dataDir, { recursive: true })
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const blob = JSON.parse(readFileSync(this.file, 'utf8')) as { iv: string; tag: string; data: string }
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(blob.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
      const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8')
      for (const rec of JSON.parse(plain) as StoredRecord[]) this.records.set(rec.accountId, rec)
    } catch {
      this.records = new Map()
    }
  }

  private persist(): void {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify([...this.records.values()])), cipher.final()])
    writeFileSync(this.file, JSON.stringify({
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }), { mode: 0o600 })
  }

  put(accountId: string, credential: MinimaxCredential, displayName: string | null): void {
    const existing = this.records.get(accountId)
    this.records.set(accountId, {
      accountId,
      credential,
      displayName: displayName ?? existing?.displayName ?? null,
      enabled: existing?.enabled ?? true,
      updatedAt: Date.now(),
    })
    this.persist()
  }

  get(accountId: string): MinimaxCredential | undefined {
    return this.records.get(accountId)?.credential
  }

  setEnabled(accountId: string, enabled: boolean): boolean {
    const rec = this.records.get(accountId)
    if (!rec) return false
    rec.enabled = enabled
    rec.updatedAt = Date.now()
    this.persist()
    return true
  }

  isEnabled(accountId: string): boolean {
    return this.records.get(accountId)?.enabled ?? true
  }

  list(): StoredRecord[] {
    return [...this.records.values()]
  }

  has(accountId: string): boolean {
    return this.records.has(accountId)
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function minimaxManifestFor(product: MinimaxProduct, extensionId = product.id): ExtensionManifest {
  return {
    apiVersion: '1.0',
    extension: {
      id: extensionId,
      version: '1.0.0',
      displayName: product.displayName,
      description: `MiniMax Code (${product.region === 'cn' ? 'China' : 'International'}) via the Anthropic Messages protocol`,
      author: 'XiNan',
      license: 'MIT',
    },
    runtime: {
      port: 8080,
      healthPath: '/health',
      env: [
        { name: 'LOG_LEVEL', required: false, default: 'info' },
        { name: 'MINIMAX_PRODUCT', required: false, default: 'minimax' },
      ],
      volumes: [
        { name: 'state', mountPath: '/data', purpose: 'encrypted credentials + device login sessions' },
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
          supportsQuota: false,
          supportsCredits: false,
          supportsStreaming: true,
          supportsVision: false,
          supportsToolCall: true,
          supportsMultipleAccounts: true,
          needsCaptcha: false,
          loginMode: 'device-code',
          protocol: 'openai-chat',
        },
        fallbackModels: product.fallbackModels.map((m) => ({
          id: m.id,
          name: m.name,
          capabilities: { vision: false, toolCall: true, streaming: true },
        })),
      },
    ],
    security: {
      permissions: {
        network: { domains: [new URL(product.apiHost).host, new URL(product.accountHost).host] },
      },
    },
    distribution: {
      image: `ghcr.io/xiaonan-520/gateway-extension-${product.id}`,
      tag: '1.0.0',
    },
  } as ExtensionManifest
}

// ---------------------------------------------------------------------------
// Extension runtime
// ---------------------------------------------------------------------------

interface DeviceSession {
  deviceCode: string
  userCode: string
  authUrl: string
  codeVerifier: string
  intervalMs: number
  startedAt: number
  expiresAt: number
  failures: number
}

/** Container entrypoint (Extension Protocol v1). */
export async function run(port: number, env: Record<string, string> = {}): Promise<void> {
  await startMinimaxExtension({ port, secret: env.GATEWAY_EXTENSION_SECRET })
  await new Promise(() => undefined)
}

export interface MinimaxExtensionOptions {
  port?: number
  dataDir?: string
  secret?: string
  fetcher?: typeof fetch
  product?: MinimaxProduct
  extensionId?: string
  now?: () => number
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function startMinimaxExtension(opts: MinimaxExtensionOptions = {}): Promise<{
  server: Server
  port: number
  endpointUrl: string
  store: MinimaxCredentialStore
  manifest: ExtensionManifest
}> {
  const fetcher = opts.fetcher ?? fetch
  const now = opts.now ?? Date.now
  const dataDir = opts.dataDir ?? '/data'
  const secret = opts.secret ?? process.env.GATEWAY_EXTENSION_SECRET ?? 'dev-only-insecure-secret'
  const product = opts.product
    ?? (process.env.MINIMAX_PRODUCT === 'minimaxintl' ? MINIMAX_INTL : MINIMAX)
  const manifest = minimaxManifestFor(product, opts.extensionId ?? product.id)
  const store = new MinimaxCredentialStore(dataDir, secret)
  const sessions = new Map<string, DeviceSession>()

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

  // -- OAuth device code -----------------------------------------------------

  async function beginDeviceLogin(): Promise<DeviceSession> {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const res = await fetcher(`${product.accountHost}${MINIMAX_DEVICE_CODE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: product.clientId,
        scope: product.scope,
        audience: product.audience,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
    })
    if (!res.ok) throwUp('UPSTREAM_5XX', `MiniMax device authorization failed (HTTP ${res.status})`, res.status)
    const body = await res.json().catch(() => null) as Record<string, unknown> | null
    const deviceCode = typeof body?.device_code === 'string' ? body.device_code : ''
    const userCode = typeof body?.user_code === 'string' ? body.user_code : ''
    const verificationUri = typeof body?.verification_uri === 'string' ? body.verification_uri : ''
    if (!deviceCode || !userCode || !verificationUri) {
      throwUp('TERMINAL', 'MiniMax device authorization response was not understood')
    }
    const expiresInSec = typeof body?.expires_in === 'number' ? body.expires_in : 600
    const intervalSec = typeof body?.interval === 'number' ? body.interval : 5
    return {
      deviceCode,
      userCode,
      authUrl: typeof body?.verification_uri_complete === 'string' ? body.verification_uri_complete : verificationUri,
      codeVerifier: verifier,
      intervalMs: Math.max(1, intervalSec) * 1000,
      startedAt: now(),
      expiresAt: now() + expiresInSec * 1000,
      failures: 0,
    }
  }

  async function pollDeviceLogin(accountId: string): Promise<{ done: boolean; success?: boolean; error?: string; displayName?: string }> {
    const session = sessions.get(accountId)
    if (!session) return { done: true, success: false, error: 'no pending device login' }
    if (now() > session.expiresAt) {
      sessions.delete(accountId)
      return { done: true, success: false, error: 'device code expired' }
    }
    const res = await fetcher(`${product.accountHost}${MINIMAX_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: buildPollBody(
        {
          deviceCode: session.deviceCode,
          userCode: session.userCode,
          verificationUri: session.authUrl,
          expiresInMs: session.expiresAt - session.startedAt,
          intervalMs: session.intervalMs,
          codeVerifier: session.codeVerifier,
        },
        product,
      ).toString(),
    })
    const body = await res.json().catch(() => null) as Record<string, unknown> | null
    if (!res.ok || typeof body?.access_token !== 'string') {
      const code = typeof body?.error === 'string' ? body.error : ''
      if (code === 'authorization_pending' || code === 'slow_down') return { done: false }
      if (code === 'expired_token' || code === 'access_denied') {
        sessions.delete(accountId)
        return { done: true, success: false, error: code }
      }
      session.failures += 1
      if (session.failures >= 5) {
        sessions.delete(accountId)
        return { done: true, success: false, error: `device login aborted: ${code || `HTTP ${res.status}`}` }
      }
      return { done: false }
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
    const credential: MinimaxCredential = {
      access_token: body.access_token,
      refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      expires_at: now() + expiresIn * 1000,
      display_name: typeof body.account_name === 'string' ? body.account_name : undefined,
      region: product.region,
    }
    store.put(accountId, credential, credential.display_name ?? null)
    sessions.delete(accountId)
    return { done: true, success: true, displayName: credential.display_name }
  }

  async function refreshCredential(accountId: string): Promise<{ refreshed: boolean; error?: string }> {
    const credential = store.get(accountId)
    if (!credential) return { refreshed: false, error: 'no credential' }
    if (!isRefreshable(credential)) return { refreshed: false, error: 'credential is not refreshable' }
    const res = await fetcher(`${product.accountHost}${MINIMAX_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: buildRefreshBody(credential.refresh_token!, product).toString(),
    })
    const body = await res.json().catch(() => null) as Record<string, unknown> | null
    if (!res.ok || typeof body?.access_token !== 'string') {
      const code = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`
      return { refreshed: false, error: code }
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
    const next: MinimaxCredential = {
      ...credential,
      access_token: body.access_token,
      // rotation: the new refresh token must be stored immediately
      refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : credential.refresh_token,
      expires_at: now() + expiresIn * 1000,
    }
    store.put(accountId, next, next.display_name ?? null)
    return { refreshed: true }
  }

  async function ensureFresh(accountId: string, credential: MinimaxCredential): Promise<MinimaxCredential> {
    if (!isExpired(credential, now())) return credential
    if (!isRefreshable(credential)) throwUp('AUTH_INVALID', 'MiniMax access token expired and the credential is not refreshable')
    const out = await refreshCredential(accountId)
    if (!out.refreshed) throwUp('AUTH_INVALID', `MiniMax token refresh failed: ${out.error ?? 'unknown'}`)
    return store.get(accountId)!
  }

  // -- upstream calls --------------------------------------------------------

  async function upstreamChat(accountId: string, body: Record<string, unknown>): Promise<Response> {
    let credential = store.get(accountId)
    if (!credential?.access_token) throwUp('AUTH_INVALID', 'account has no MiniMax access token')
    credential = await ensureFresh(accountId, credential)

    const messages = Array.isArray(body.messages) ? (body.messages as OpenAiMessage[]) : []
    const payload = buildMinimaxPayload({
      model: bareOf(typeof body.model === 'string' ? body.model : ''),
      messages,
      ...(typeof body.max_tokens === 'number' ? { maxTokens: body.max_tokens } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(Array.isArray(body.tools) && body.tools.length > 0
        ? { tools: body.tools as NonNullable<Parameters<typeof buildMinimaxPayload>[0]['tools']> }
        : {}),
    })

    const res = await fetcher(`${product.apiHost}${product.inferPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${credential.access_token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      const c = classify(res.status, `MiniMax chat failed (HTTP ${res.status})${text ? `: ${text}` : ''}`)
      throwUp(c.kind, c.message, res.status)
    }
    return res
  }

  async function modelsFor(accountId: string): Promise<Array<{ id: string; name: string; capabilities: { vision: boolean; toolCall: boolean; streaming: boolean } }>> {
    const fallback = product.fallbackModels.map((m) => ({
      id: m.id,
      name: m.name,
      capabilities: { vision: false, toolCall: true, streaming: true },
    }))
    const credential = store.get(accountId)
    if (!credential?.access_token) return fallback
    try {
      const res = await fetcher(
        `${product.apiHost}${product.modelsPath}?region=${product.region}&buildEnv=prod`,
        { headers: { authorization: `Bearer ${credential.access_token}` } },
      )
      if (!res.ok) return fallback
      const body = await res.json().catch(() => null) as Record<string, unknown> | null
      const list = Array.isArray(body?.models) ? body!.models as Array<Record<string, unknown>>
        : Array.isArray(body?.data) ? body!.data as Array<Record<string, unknown>>
          : []
      const out = list
        .map((m) => {
          const id = typeof m.id === 'string' ? m.id : typeof m.model === 'string' ? m.model : ''
          if (!id) return undefined
          return {
            id,
            name: typeof m.name === 'string' ? m.name : id,
            capabilities: { vision: false, toolCall: true, streaming: true },
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== undefined)
      return out.length > 0 ? out : fallback
    } catch {
      return fallback
    }
  }

  // -- SSE consumption -------------------------------------------------------

  /** Fold the Anthropic SSE stream into canonical chunks (non-empty only). */
  async function* consumeStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatChunk> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // tool_use blocks are indexed by their content-block index
    const toolIndex = new Map<number, number>()
    let nextToolIndex = 0
    let sawFinish = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawFrame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          let dataLine = ''
          for (const line of rawFrame.split('\n')) {
            if (line.startsWith('data:')) dataLine += line.slice(5).trim()
          }
          if (dataLine === '' || dataLine === '[DONE]') continue
          let chunks: MinimaxChunk[]
          try {
            chunks = parseMinimaxEvent(dataLine)
          } catch (err) {
            throw err
          }
          for (const c of chunks) {
            const out: ChatChunk = { text: c.text }
            if (c.reasoning !== undefined && c.reasoning !== '') out.reasoning = c.reasoning
            if (c.usage !== undefined) out.usage = c.usage
            if (c.toolCalls && c.toolCalls.length > 0) {
              out.toolCalls = c.toolCalls.map((tc) => {
                const upstreamIndex = tc.index ?? 0
                let wireIndex = toolIndex.get(upstreamIndex)
                if (wireIndex === undefined) {
                  wireIndex = nextToolIndex++
                  toolIndex.set(upstreamIndex, wireIndex)
                }
                return { ...tc, index: wireIndex }
              })
            }
            if (c.finishReason !== undefined && c.finishReason !== null) {
              out.finishReason = c.finishReason
              sawFinish = true
            }
            // Drop no-op frames: only real increments reach the client.
            if (out.text === '' && out.reasoning === undefined
              && out.toolCalls === undefined && out.finishReason === undefined
              && out.usage === undefined) {
              continue
            }
            yield out
          }
        }
      }
      if (!sawFinish) yield { text: '', finishReason: 'stop' }
    } finally {
      reader.releaseLock()
    }
  }

  // -- protocol projection ---------------------------------------------------

  function accountsProjection(): unknown {
    return {
      accounts: store.list().map((rec) => {
        const expired = isExpired(rec.credential, now())
        return {
          accountId: rec.accountId,
          providerId: product.id,
          displayName: rec.displayName ?? rec.accountId,
          status: !rec.enabled ? 'disabled' : expired ? (isRefreshable(rec.credential) ? 'token_expired' : 'auth_failed') : 'active',
          manualAction: null,
          quota: null,
          lastError: null,
          lastSuccessAt: new Date(rec.updatedAt).toISOString(),
          lastFailureAt: null,
          metadata: { refreshable: isRefreshable(rec.credential), region: product.region },
        }
      }),
    }
  }

  function chunkToSseEvent(chunk: ChatChunk): string {
    return `event: chunk\ndata: ${JSON.stringify(chunk)}\n\n`
  }

  async function handleChatStream(accountId: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const upstream = await upstreamChat(accountId, body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    try {
      for await (const chunk of consumeStream(upstream.body as unknown as ReadableStream<Uint8Array>)) {
        res.write(chunkToSseEvent(chunk))
      }
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
      return send(res, 200, {
        status: 'healthy',
        version: manifest.extension.version,
        accounts: { total: store.list().length, usable: store.list().filter((r) => r.enabled).length },
      })
    }

    if (!verifyAuth(req)) {
      // Core↔Extension credential mismatch: EXTENSION_AUTH lets Core re-register
      // instead of parking the provider account.
      return send(res, 401, { error: { kind: 'EXTENSION_AUTH', message: 'extension auth token mismatch' } })
    }

    if (req.method === 'GET' && path === '/v1/models') {
      const accountId = url.searchParams.get('account_id') ?? store.list()[0]?.accountId ?? ''
      return send(res, 200, { models: await modelsFor(accountId) })
    }

    if (req.method === 'GET' && path === '/v1/accounts') return send(res, 200, accountsProjection())

    if (req.method === 'POST' && path === '/v1/accounts') {
      const body = await readJson(req) as Record<string, unknown> | undefined
      if (body && ['access_token', 'refresh_token', 'password', 'api_key', 'secret'].some((k) => k in body)) {
        return send(res, 400, {
          error: { kind: 'PROTOCOL_VIOLATION', message: 'credential fields are forbidden in account creation (RFC §10.3)' },
        })
      }
      const requested = typeof body?.accountId === 'string' && body.accountId.length > 0
        ? body.accountId
        : `${product.id}-${randomUUID().slice(0, 8)}`
      if (store.has(requested) || sessions.has(requested)) {
        return send(res, 409, { error: { kind: 'TERMINAL', message: `account ${requested} already exists` } })
      }
      const session = await beginDeviceLogin()
      sessions.set(requested, session)
      return send(res, 201, {
        accountId: requested,
        status: 'pending',
        authorizationUrl: session.authUrl,
        userCode: session.userCode,
        expiresIn: Math.floor((session.expiresAt - now()) / 1000),
        pollInterval: Math.max(1, Math.floor(session.intervalMs / 1000)),
      })
    }

    const acctMatch = /^\/v1\/accounts\/([A-Za-z0-9_-]+)(?:\/(refresh|enable|disable))?$/.exec(path)
    if (acctMatch) {
      const [, accountId, op] = acctMatch
      if (!op) {
        const pending = sessions.get(accountId)
        const rec = store.list().find((r) => r.accountId === accountId)
        if (!rec && !pending) return send(res, 404, { error: { kind: 'TERMINAL', message: `unknown account ${accountId}` } })
        if (!rec && pending) {
          const poll = await pollDeviceLogin(accountId)
          if (poll.done && !poll.success) {
            return send(res, 200, {
              account: {
                accountId, providerId: product.id, displayName: accountId, status: 'auth_failed',
                manualAction: null, quota: null, lastError: poll.error ?? 'login failed',
                lastSuccessAt: null, lastFailureAt: new Date().toISOString(), metadata: {},
              },
            })
          }
          if (poll.done && poll.success) {
            const accounts = (accountsProjection() as { accounts: Array<{ accountId: string }> }).accounts
            return send(res, 200, { account: accounts.find((a) => a.accountId === accountId) })
          }
          return send(res, 200, {
            account: {
              accountId, providerId: product.id, displayName: accountId, status: 'pending',
              manualAction: null, quota: null, lastError: null, lastSuccessAt: null, lastFailureAt: null,
              metadata: { loginUrl: pending.authUrl, userCode: pending.userCode },
            },
          })
        }
        const accounts = (accountsProjection() as { accounts: Array<{ accountId: string }> }).accounts
        return send(res, 200, { account: accounts.find((a) => a.accountId === accountId) })
      }
      if (op === 'refresh') {
        const out = await refreshCredential(accountId)
        const credential = store.get(accountId)
        return send(res, 200, {
          status: out.refreshed ? 'active' : 'auth_failed',
          refreshed: out.refreshed,
          error: out.error ?? null,
          expiresAt: credential?.expires_at ?? null,
        })
      }
      if (op === 'enable' || op === 'disable') {
        const accepted = store.setEnabled(accountId, op === 'enable')
        return send(res, 200, { accountId, accepted, status: op === 'enable' ? 'active' : 'disabled' })
      }
    }

    if (req.method === 'POST' && path === '/v1/chat') {
      const body = await readJson(req) as Record<string, unknown>
      const accountId = String(body.accountId ?? '')
      if (!store.has(accountId)) return send(res, 404, { error: { kind: 'TERMINAL', message: `unknown account ${accountId}` } })
      if (body.stream === true) return handleChatStream(accountId, body, res)

      // Non-streaming: aggregate the same chunk stream.
      const upstream = await upstreamChat(accountId, body)
      let content = ''
      let reasoning = ''
      let finishReason: string | null = null
      let usage: Record<string, unknown> | undefined
      const toolOrder: number[] = []
      const toolMap = new Map<number, { id?: string; name?: string; arguments: string }>()
      try {
        for await (const chunk of consumeStream(upstream.body as unknown as ReadableStream<Uint8Array>)) {
          content += chunk.text
          if (chunk.reasoning) reasoning += chunk.reasoning
          if (chunk.finishReason) finishReason = chunk.finishReason
          if (chunk.usage) usage = chunk.usage as Record<string, unknown>
          if (chunk.toolCalls) {
            for (const call of chunk.toolCalls) {
              const last = toolOrder.length > 0 ? toolMap.get(toolOrder[toolOrder.length - 1]!) : undefined
              if (call.id || !last) {
                const entry = { id: call.id, name: call.name, arguments: call.arguments ?? '' }
                toolMap.set(toolOrder.length, entry)
                toolOrder.push(toolOrder.length)
              } else {
                if (call.name) last.name = call.name
                if (call.arguments) last.arguments += call.arguments
              }
            }
          }
        }
      } catch (err) {
        const e = err as Error & { upKind?: string; upStatus?: number }
        return send(res, 502, { error: { kind: e.upKind ?? 'TRANSPORT', message: e.message } })
      }
      const out: Record<string, unknown> = { content, finishReason: finishReason ?? 'stop' }
      if (reasoning !== '') out.reasoning = reasoning
      if (usage) out.usage = usage
      if (toolOrder.length > 0) out.toolCalls = toolOrder.map((i) => toolMap.get(i)!)
      return send(res, 200, out)
    }

    send(res, 404, { error: { kind: 'TERMINAL', message: `no such route: ${req.method} ${path}` } })
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      const e = err as Error & { upKind?: string; upStatus?: number }
      if (!res.headersSent) {
        send(res, e.upStatus && e.upStatus >= 400 ? (e.upKind === 'AUTH_INVALID' ? 502 : e.upStatus) : 500, {
          error: { kind: e.upKind ?? 'TERMINAL', message: e.message },
        })
      } else {
        res.end()
      }
    })
  })

  const port = opts.port ?? 0
  await new Promise<void>((resolve) => server.listen(port, process.env.MINIMAX_BIND_HOST ?? '0.0.0.0', () => resolve()))
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port

  return {
    server,
    port: actualPort,
    endpointUrl: `http://127.0.0.1:${actualPort}`,
    store,
    manifest,
  }
}
