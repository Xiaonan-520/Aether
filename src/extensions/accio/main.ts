/**
 * Accio (Alibaba Accio Work) Extension — one image, two login regions.
 *
 * Login is a **loopback browser-callback** flow (OAuth code + PKCE): the
 * extension starts a temporary HTTP listener, hands the operator a URL, and
 * the upstream redirects back to it with `code` + `state`. The callback host
 * must be reachable FROM THE OPERATOR'S BROWSER, so in a container deployment
 * the region + callback base are operator inputs:
 *
 *   ACCIO_PRODUCT=accio
 *   ACCIO_REGION=cn|global            (login page host — server-assigned per account)
 *   ACCIO_CALLBACK_BASE=http://host:port   (must be reachable from the browser)
 *
 * The LLM gateway host is region-independent (phoenix-gw.alibaba.com).
 *
 * Upstream protocol (Gemini-style, snake_case): token in BODY, string
 * system_instruction, stringified tool schemas, un-converted properties
 * subtree — see providers/accio/protocol.ts for the full trap list.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import {
  ACCIO,
  ACCIO_LLM_PATH,
  ACCIO_TOKEN_EXCHANGE_PATH,
  ACCIO_REFRESH_PATH,
  ACCIO_USERINFO_PATH,
  accioHeaders,
  accioRequestId,
  accioSgK,
  buildAccioBody,
  isAccioRefreshable,
  isExpired,
  type AccioCredential,
  type AccioProduct,
  type AccioRegion,
} from '../../providers/accio/protocol.js'
import type { ExtensionManifest } from '../../protocol/extension/manifest.js'
import type { ChatChunk } from '../../core/types.js'

interface StoredRecord {
  accountId: string
  credential: AccioCredential
  displayName: string | null
  enabled: boolean
  updatedAt: number
}

class AccioCredentialStore {
  private readonly key: Buffer
  private readonly file: string
  private records = new Map<string, StoredRecord>()

  constructor(dataDir: string, secret: string) {
    this.key = scryptSync(secret, 'gw-ext-accio-salt-v1', 32)
    this.file = join(dataDir, 'accio-credentials.json.enc')
    mkdirSync(dataDir, { recursive: true })
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

  put(accountId: string, credential: AccioCredential, displayName: string | null): void {
    const existing = this.records.get(accountId)
    this.records.set(accountId, {
      accountId, credential,
      displayName: displayName ?? existing?.displayName ?? null,
      enabled: existing?.enabled ?? true, updatedAt: Date.now(),
    })
    this.persist()
  }

  get(accountId: string): AccioCredential | undefined {
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
}

export function accioManifestFor(product: AccioProduct, region: AccioRegion, extensionId = product.id): ExtensionManifest {
  return {
    apiVersion: '1.0',
    extension: {
      id: extensionId,
      version: '1.0.0',
      displayName: `${product.displayName}`,
      description: `Accio Work via the Alibaba gateway (login region: ${region})`,
      author: 'XiNan',
      license: 'MIT',
    },
    runtime: {
      port: 8080,
      healthPath: '/health',
      env: [
        { name: 'LOG_LEVEL', required: false, default: 'info' },
        { name: 'MINIMAX_PRODUCT', required: false, default: 'minimax' },
        { name: 'ACCIO_PRODUCT', required: false, default: 'accio' },
        { name: 'ACCIO_REGION', required: false, default: 'cn' },
        // the browser must be able to reach this for the OAuth callback
        { name: 'ACCIO_CALLBACK_BASE', required: false, default: '' },
      ],
      volumes: [{ name: 'state', mountPath: '/data', purpose: 'encrypted credentials' }],
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
          supportsVision: true,
          supportsToolCall: true,
          supportsMultipleAccounts: true,
          needsCaptcha: false,
          loginMode: 'external-link',
          protocol: 'openai-chat',
        },
        fallbackModels: product.fallbackModels.map((m) => ({
          id: m.id,
          name: `${m.name} · x${m.multiple}`,
          capabilities: { vision: m.supportsImage, toolCall: true, streaming: true },
        })),
        // conformance requires ≥1 declared action; a pure read-only status probe
        actions: [
          {
            id: 'account-status',
            httpMethod: 'POST',
            title: 'Read account status',
            mode: 'read',
            sideEffects: 'none',
            ui: 'none',
            inputSchema: { type: 'object', properties: { account_id: { type: 'string' } } },
            outputSchema: { type: 'object', properties: { accountId: { type: 'string' }, status: { type: 'string' }, region: { type: 'string' } } },
          },
        ],
      },
    ],
    security: {
      permissions: { network: { domains: [new URL(product.gatewayBaseUrl).host] } },
    },
    distribution: { image: `ghcr.io/xiaonan-520/gateway-extension-${product.id}`, tag: '1.0.0' },
  } as ExtensionManifest
}

export interface AccioExtensionOptions {
  port?: number
  dataDir?: string
  secret?: string
  fetcher?: typeof fetch
  product?: AccioProduct
  region?: AccioRegion
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
  try { return JSON.parse(text) } catch { return undefined }
}

export async function startAccioExtension(opts: AccioExtensionOptions = {}): Promise<{
  server: Server
  port: number
  endpointUrl: string
  store: AccioCredentialStore
  manifest: ExtensionManifest
}> {
  const fetcher = opts.fetcher ?? fetch
  const now = opts.now ?? Date.now
  const dataDir = opts.dataDir ?? '/data'
  const secret = opts.secret ?? process.env.GATEWAY_EXTENSION_SECRET ?? 'dev-only-insecure-secret'
  const region = (opts.region ?? (process.env.ACCIO_REGION as AccioRegion | undefined) ?? 'cn')
  const product = opts.product ?? ACCIO
  const manifest = accioManifestFor(product, region, opts.extensionId ?? product.id)
  const store = new AccioCredentialStore(dataDir, secret)
  // one pending browser-callback login at a time
  let pending: { accountId: string; state: string; verifier: string; redirectUri: string; expiresAt: number; region: AccioRegion } | null = null

  function classify(status: number, message: string): { kind: string; message: string } {
    if (status === 401 || status === 402 || status === 403) return { kind: 'AUTH_INVALID', message }
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

  // -- login -----------------------------------------------------------------

  function tokenExchange(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return fetcher(`${ACCIO.gatewayBaseUrl}${ACCIO_TOKEN_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).then(async (res) => {
      const payload = await res.json().catch(() => null) as Record<string, unknown> | null
      if (!res.ok || !payload || typeof payload.access_token !== 'string') {
        throwUp('AUTH_INVALID', `Accio token exchange failed (HTTP ${res.status})`)
      }
      return payload
    })
  }

  async function beginBrowserLogin(accountId: string, callbackBase: string): Promise<{ authorizationUrl: string; userCode: string }> {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(32).toString('hex')
    const port = callbackBase.match(/:(\d+)(?:\/|$)/)?.[1] ?? '80'
    const redirectUri = `${callbackBase.replace(/\/$/, '')}/auth/callback`
    const params = new URLSearchParams({
      return_url: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      client_id: ACCIO.clientId,
      ttid: `ttid_${randomBytes(16).toString('hex')}`,
      language: 'zh',
    })
    const authorizationUrl = `${ACCIO.loginBaseUrlOf(region)}/login?${params.toString()}`
    pending = { accountId, state, verifier, redirectUri, expiresAt: now() + 600_000, region }
    // the loopback listener is handled by the main server at /auth/callback
    return { authorizationUrl, userCode: `port=${port}` }
  }

  async function completeBrowserLogin(accountId: string, code: string, state: string): Promise<void> {
    if (!pending) throwUp('TERMINAL', 'no pending Accio login')
    if (pending.state !== state) throwUp('TERMINAL', 'state mismatch')
    if (now() > pending.expiresAt) {
      pending = null
      throwUp('TERMINAL', 'login session expired')
    }
    const payload = await tokenExchange({
      code, codeVerifier: pending.verifier, clientId: ACCIO.clientId, redirectUri: pending.redirectUri,
    })
    const displayName = typeof payload.display_name === 'string' ? payload.display_name : undefined
    const credential: AccioCredential = {
      access_token: String(payload.access_token),
      refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
      region: pending.region,
      expires_at: typeof payload.expires_in === 'number' ? now() + payload.expires_in * 1000 : undefined,
      display_name: displayName,
    }
    store.put(accountId, credential, null)
    pending = null
  }

  async function refreshCredential(accountId: string): Promise<{ refreshed: boolean; error?: string }> {
    const credential = store.get(accountId)
    if (!credential) return { refreshed: false, error: 'no credential' }
    if (!isAccioRefreshable(credential)) return { refreshed: false, error: 'not refreshable' }
    try {
      const res = await fetcher(`${ACCIO.gatewayBaseUrl}${ACCIO_REFRESH_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ accessToken: credential.access_token, refreshToken: credential.refresh_token }),
        signal: AbortSignal.timeout(60_000),
      })
      const payload = await res.json().catch(() => null) as Record<string, unknown> | null
      if (!res.ok || !payload || typeof payload.access_token !== 'string') {
        return { refreshed: false, error: `HTTP ${res.status}` }
      }
      const next: AccioCredential = {
        ...credential,
        access_token: payload.access_token,
        // rotation: store the new refresh token immediately
        refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : credential.refresh_token,
        expires_at: typeof payload.expires_in === 'number' ? now() + payload.expires_in * 1000 : credential.expires_at,
      }
      store.put(accountId, next, next.display_name ?? null)
      return { refreshed: true }
    } catch (err) {
      return { refreshed: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async function ensureFresh(accountId: string, credential: AccioCredential): Promise<AccioCredential> {
    if (!isExpired(credential, now())) return credential
    if (!isAccioRefreshable(credential)) throwUp('AUTH_INVALID', 'Accio access token expired and not refreshable')
    const out = await refreshCredential(accountId)
    if (!out.refreshed) throwUp('AUTH_INVALID', `Accio token refresh failed: ${out.error ?? 'unknown'}`)
    return store.get(accountId)!
  }

  // -- upstream --------------------------------------------------------------

  function utdid(): string {
    // stable per-process identity; the upstream treats it as opaque
    return process.env.ACCIO_UTDID ?? `accio-${randomUUID().slice(0, 8)}`
  }

  async function upstreamChat(accountId: string, body: Record<string, unknown>): Promise<Response> {
    let credential = store.get(accountId)
    if (!credential?.access_token) throwUp('AUTH_INVALID', 'account has no Accio access token')
    credential = await ensureFresh(accountId, credential)

    const requestId = accioRequestId()
    const url = `${ACCIO.gatewayBaseUrl}${ACCIO_LLM_PATH}?sg_k=${accioSgK(requestId)}`
    const messages = Array.isArray(body.messages) ? (body.messages as NonNullable<Parameters<typeof buildAccioBody>[0]['messages']>) : []
    const payload = buildAccioBody({
      model: bareOf(typeof body.model === 'string' ? body.model : ''),
      accessToken: credential.access_token,
      messages,
      utdid: utdid(),
      requestId,
      ...(typeof body.max_tokens === 'number' ? { maxOutputTokens: body.max_tokens } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(Array.isArray(body.tools) && body.tools.length > 0 ? { tools: body.tools } : {}),
    })
    const res = await fetcher(url, {
      method: 'POST',
      headers: accioHeaders(utdid()),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      const c = classify(res.status, `Accio chat failed (HTTP ${res.status})${text ? `: ${text}` : ''}`)
      throwUp(c.kind, c.message, res.status)
    }
    return res
  }

  async function modelsFor(): Promise<Array<{ id: string; name: string; capabilities: { vision: boolean; toolCall: boolean; streaming: boolean } }>> {
    const fallback = ACCIO.fallbackModels.map((m) => ({
      id: m.id,
      name: `${m.name} · x${m.multiple}`,
      capabilities: { vision: m.supportsImage, toolCall: true, streaming: true },
    }))
    try {
      const credential = store.list().find((r) => r.enabled)?.credential
      if (!credential?.access_token) return fallback
      const res = await fetcher(`${ACCIO.gatewayBaseUrl}${ACCIO_USERINFO_PATH}`, {
        headers: { ...accioHeaders(utdid()), authorization: `Bearer ${credential.access_token}` },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return fallback
      return fallback // catalog endpoint is account-scoped; keep fallback unless known
    } catch {
      return fallback
    }
  }

  // -- SSE -------------------------------------------------------------------

  async function* consumeStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatChunk> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
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
          for (const line of rawFrame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const dataLine = line.slice(5).trim()
            if (dataLine === '' || dataLine === '[DONE]') continue
            // parseAccioEvent throws on in-stream error codes — propagate
            for (const chunk of await Promise.resolve(parseAccioEventSafe(dataLine))) {
              if (chunk.finishReason !== undefined && chunk.finishReason !== null) sawFinish = true
              yield chunk
            }
          }
        }
      }
      if (!sawFinish) yield { text: '', finishReason: 'stop' }
    } finally {
      reader.releaseLock()
    }
  }

  async function parseAccioEventSafe(dataLine: string): Promise<ChatChunk[]> {
    // lazy import keeps the protocol module pure
    const { parseAccioEvent } = await import('../../providers/accio/protocol.js')
    const chunks: Array<{ text: string; reasoning?: string; finishReason?: 'stop' | 'length' | 'tool_calls' | null; usage?: { promptTokens?: number; completionTokens?: number }; toolCalls?: Array<{ id?: string; name?: string; arguments?: string; index?: number }> }> = []
    try {
      chunks.push(...parseAccioEvent(dataLine))
    } catch (err) {
      const e = err as Error & { upKind?: string }
      throw Object.assign(new Error(e.message), { upKind: e.upKind ?? 'TERMINAL' })
    }
    // empty-frame discipline
    return chunks.filter((c) => c.text !== '' || c.reasoning !== undefined
      || (c.toolCalls !== undefined && c.toolCalls.length > 0)
      || c.finishReason !== undefined)
  }

  // -- projection ------------------------------------------------------------

  function accountsProjection(): unknown {
    return {
      accounts: store.list().map((rec) => {
        const expired = isExpired(rec.credential, now())
        return {
          accountId: rec.accountId,
          providerId: product.id,
          displayName: rec.displayName ?? rec.accountId,
          status: !rec.enabled ? 'disabled' : expired ? (isAccioRefreshable(rec.credential) ? 'token_expired' : 'auth_failed') : 'active',
          manualAction: null,
          quota: null,
          lastError: null,
          lastSuccessAt: new Date(rec.updatedAt).toISOString(),
          lastFailureAt: null,
          metadata: { region: rec.credential.region, refreshable: isAccioRefreshable(rec.credential) },
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
    if (!expected) return true
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

    // OAuth callback — open path (the browser has no extension token)
    if (req.method === 'GET' && path === '/auth/callback') {
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!code || !state || !pending) {
        return send(res, 400, { error: { kind: 'TERMINAL', message: 'missing code/state or no pending login' } })
      }
      try {
        await completeBrowserLogin(pending.accountId, code, state)
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('Accio login complete. You can close this tab.')
      } catch (err) {
        const e = err as Error & { upKind?: string }
        send(res, e.upKind === 'AUTH_INVALID' ? 502 : 400, { error: { kind: e.upKind ?? 'TERMINAL', message: e.message } })
      }
      return
    }

    if (!verifyAuth(req)) {
      return send(res, 401, { error: { kind: 'EXTENSION_AUTH', message: 'extension auth token mismatch' } })
    }

    if (req.method === 'GET' && path === '/v1/models') return send(res, 200, { models: await modelsFor() })
    if (req.method === 'GET' && path === '/v1/accounts') return send(res, 200, accountsProjection())

    if (req.method === 'POST' && path === '/v1/accounts') {
      const body = await readJson(req) as Record<string, unknown> | undefined
      if (body && ['access_token', 'refresh_token', 'password', 'api_key', 'secret'].some((k) => k in body)) {
        return send(res, 400, { error: { kind: 'PROTOCOL_VIOLATION', message: 'credential fields are forbidden in account creation (RFC §10.3)' } })
      }
      const requested = typeof body?.accountId === 'string' && body.accountId.length > 0
        ? body.accountId
        : `${product.id}-${randomUUID().slice(0, 8)}`
      const callbackBase = typeof body?.callbackBase === 'string' && body.callbackBase !== ''
        ? body.callbackBase
        : process.env.ACCIO_CALLBACK_BASE ?? ''
      if (callbackBase === '') {
        return send(res, 400, {
          error: { kind: 'TERMINAL', message: 'callbackBase is required: the browser must reach this extension for the OAuth callback (e.g. http://<server-lan-ip>:<port>)' },
        })
      }
      if (pending) return send(res, 409, { error: { kind: 'TERMINAL', message: 'a browser login is already pending' } })
      const login = await beginBrowserLogin(requested, callbackBase)
      return send(res, 201, {
        accountId: requested,
        status: 'pending',
        authorizationUrl: login.authorizationUrl,
        // operator hint: which port the callback listener expects
        callbackPath: '/auth/callback',
      })
    }

    const acctMatch = /^\/v1\/accounts\/([A-Za-z0-9_-]+)(?:\/(refresh|enable|disable))?$/.exec(path)
    if (acctMatch) {
      const [, accountId, op] = acctMatch
      if (!op) {
        const rec = store.list().find((r) => r.accountId === accountId)
        if (!rec) return send(res, 404, { error: { kind: 'TERMINAL', message: `unknown account ${accountId}` } })
        const accounts = (accountsProjection() as { accounts: unknown[] }).accounts
        return send(res, 200, { account: (accounts as Array<{ accountId: string }>).find((a) => a.accountId === accountId) })
      }
      if (op === 'refresh') {
        const out = await refreshCredential(accountId)
        return send(res, 200, { status: out.refreshed ? 'active' : 'auth_failed', refreshed: out.refreshed, error: out.error ?? null })
      }
      if (op === 'enable' || op === 'disable') {
        const accepted = store.setEnabled(accountId, op === 'enable')
        return send(res, 200, { accountId, accepted, status: op === 'enable' ? 'active' : 'disabled' })
      }
    }

    if (req.method === 'POST' && path === '/v1/actions/account-status') {
      // Declared read-only action: normalized projection only, no credentials.
      const body = await readJson(req) as { payload?: { account_id?: unknown } } | undefined
      const payload = (body?.payload ?? {}) as Record<string, unknown>
      const accountId = typeof payload.account_id === 'string' ? payload.account_id : store.list()[0]?.accountId ?? ''
      const rec = store.list().find((r) => r.accountId === accountId)
      if (!rec) return send(res, 200, { result: { accountId, status: 'unknown', region } })
      const expired = isExpired(rec.credential, now())
      const status = !rec.enabled ? 'disabled' : expired ? (isAccioRefreshable(rec.credential) ? 'token_expired' : 'auth_failed') : 'active'
      return send(res, 200, { result: { accountId, status, region } })
    }

    if (req.method === 'POST' && path === '/v1/chat') {
      const body = await readJson(req) as Record<string, unknown>
      const accountId = String(body.accountId ?? '')
      if (!store.has(accountId)) return send(res, 404, { error: { kind: 'TERMINAL', message: `unknown account ${accountId}` } })
      if (body.stream === true) return handleChatStream(accountId, body, res)

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
                toolMap.set(toolOrder.length, { id: call.id, name: call.name, arguments: call.arguments ?? '' })
                toolOrder.push(toolOrder.length)
              } else {
                if (call.name) last.name = call.name
                if (call.arguments) last.arguments += call.arguments
              }
            }
          }
        }
      } catch (err) {
        const e = err as Error & { upKind?: string }
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
        send(res, e.upStatus && e.upStatus >= 400 ? e.upStatus : 500, { error: { kind: e.upKind ?? 'TERMINAL', message: e.message } })
      } else res.end()
    })
  })

  const port = opts.port ?? 0
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', () => resolve()))
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  return { server, port: actualPort, endpointUrl: `http://127.0.0.1:${actualPort}`, store, manifest }
}

/** Container entrypoint. */
export async function run(port: number, env: Record<string, string> = {}): Promise<void> {
  await startAccioExtension({ port, secret: env.GATEWAY_EXTENSION_SECRET })
  await new Promise(() => undefined)
}
