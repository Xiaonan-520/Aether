/**
 * Extension SDK — HTTP server skeleton for the Extension Protocol v1.
 *
 * Endpoints (all protocol-mandated routes prewired):
 *   GET  /manifest            open (Manager install handshake reads it)
 *   GET  /health              open (container healthcheck)
 *   GET  /v1/accounts         adapter.listAccounts
 *   POST /v1/accounts         adapter.createAccount (credential fields rejected)
 *   GET  /v1/accounts/:id     adapter.getAccount
 *   POST /v1/accounts/:id/refresh    adapter.refresh
 *   POST /v1/accounts/:id/enable     adapter.setEnabled(true)
 *   POST /v1/accounts/:id/disable    adapter.setEnabled(false)
 *   GET  /v1/accounts/:id/quota      adapter.quota
 *   POST /v1/accounts/:id/claim      adapter.claim
 *   GET  /v1/models           adapter.models
 *   POST /v1/chat            adapter.chat / adapter.chatStream (SSE)
 *   POST /v1/actions/:actionId      whitelist from the manifest + adapter.invokeAction
 *
 * The adapter surface is intentionally close to Core's Provider seam so a
 * local provider lifts into an extension with a 1:1 method mapping. Auth is
 * enforced on everything except /health and /manifest. Errors always leave
 * as { error: { kind, message, ... } }.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { checkExtensionAuth, ExtensionAuthError } from './auth.js'
import {
  ExtensionProtocolError,
  errors,
  sanitizeLogFields,
  toExtensionError,
} from './errors.js'
import { matchRoute, parsePath, readJsonObject, writeJson, type SdkRoute } from './http.js'
import { declaredActionIds, validateManifestShape, type SdkExtensionManifest } from './manifest.js'

// ---------------------------------------------------------------------------
// adapter + options
// ---------------------------------------------------------------------------

export interface SdkChatRequest {
  messages: Array<{ role: string; content: unknown; [key: string]: unknown }>
  model: string
  stream: boolean
  accountId: string
  requestId: string
  deadlineMs: number
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string
  tools?: unknown[]
}

export interface SdkChatChunk {
  text?: string
  reasoning?: string
  toolCalls?: unknown[]
  finishReason?: string
  usage?: Record<string, unknown>
}

export interface SdkChatRuntime {
  accountId: string
  requestId: string
  deadlineMs: number
  signal: AbortSignal
}

/**
 * The extension's business surface. Methods may throw anything; the SDK
 * normalizes via toExtensionError. Not every extension implements every
 * method — omit and the route answers 501 TERMINAL.
 */
export interface ExtensionAdapter {
  listAccounts(): Promise<Array<Record<string, unknown>>>
  getAccount?(id: string): Promise<Record<string, unknown> | null>
  createAccount?(body: Record<string, unknown>): Promise<Record<string, unknown>>
  refresh?(id: string): Promise<Record<string, unknown>>
  setEnabled?(id: string, enabled: boolean): Promise<Record<string, unknown>>
  quota?(id: string, detailed: boolean): Promise<Record<string, unknown>>
  claim?(id: string): Promise<Record<string, unknown>>
  models?(accountId: string): Promise<{ models: Array<Record<string, unknown>> }>
  chat?(req: SdkChatRequest, runtime: SdkChatRuntime): Promise<Record<string, unknown>>
  chatStream?(req: SdkChatRequest, runtime: SdkChatRuntime): AsyncIterable<SdkChatChunk>
  /** actionId already whitelist-checked against the manifest */
  invokeAction?(actionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>
}

export interface ExtensionSdkOptions {
  /** protocol manifest (validated at startup; serving shape = install handshake truth) */
  manifest: SdkExtensionManifest
  /** EXTENSION_AUTH_TOKEN; undefined keeps the server in open local/dev mode */
  authToken?: string
  adapter: ExtensionAdapter
  logger?: { info: (event: string, fields?: Record<string, unknown>) => void }
  /** override the built-in /health payload (defaults to status+version) */
  health?: () => { status: 'healthy' | 'degraded' | 'unhealthy'; [key: string]: unknown }
}

// ---------------------------------------------------------------------------
// request registry (in-flight chat cancellation on client disconnect)
// ---------------------------------------------------------------------------

export class RequestRegistry {
  private readonly active = new Map<string, AbortController>()

  register(requestId: string, _accountId: string | undefined, controller: AbortController): void {
    this.active.set(requestId, controller)
  }

  unregister(requestId: string): void {
    this.active.delete(requestId)
  }

  abortAll(): void {
    for (const c of this.active.values()) c.abort()
    this.active.clear()
  }

  get size(): number {
    return this.active.size
  }
}

// ---------------------------------------------------------------------------
// server factory
// ---------------------------------------------------------------------------

const CREDENTIAL_FIELDS = ['access_token', 'refresh_token', 'password', 'api_key', 'secret', 'token']

export function createExtensionHttpServer(opts: ExtensionSdkOptions): Server {
  const manifest = validateManifestShape(opts.manifest)
  const adapter = opts.adapter
  const logger = opts.logger
  const registry = new RequestRegistry()
  const allowedActions = new Set(declaredActionIds(manifest))

  const notImplemented = (what: string): ExtensionProtocolError =>
    errors.terminal(`${what} is not implemented by this extension`, { responseStatus: 501 })

  function requireAccount(id: string): Promise<Record<string, unknown>> {
    return adapter.getAccount!(id).then((a) => {
      if (!a) throw errors.terminal(`unknown account ${id}`, { responseStatus: 404 })
      return a
    })
  }

  // ── handlers ────────────────────────────────────────────
  async function handleManifest(ctx: { res: ServerResponse }): Promise<void> {
    writeJson(ctx.res, 200, manifest)
  }

  async function handleHealth(ctx: { res: ServerResponse }): Promise<void> {
    if (opts.health) {
      writeJson(ctx.res, 200, { version: manifest.extension.version, ...opts.health() })
      return
    }
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
    let accounts = { total: 0, usable: 0 }
    try {
      const list = await adapter.listAccounts()
      accounts = {
        total: list.length,
        usable: list.filter((a) => a.status === 'active').length,
      }
    } catch {
      status = 'degraded'
    }
    writeJson(ctx.res, 200, { status, version: manifest.extension.version, accounts })
  }

  async function handleCreateAccount(ctx: { req: IncomingMessage; res: ServerResponse }): Promise<void> {
    if (!adapter.createAccount) throw notImplemented('account creation')
    const body = await readJsonObject(ctx.req)
    // Credential fields are forbidden on this channel (RFC §10.3).
    for (const key of CREDENTIAL_FIELDS) {
      if (key in body) throw errors.protocolViolation(`credential field "${key}" is forbidden in account creation`)
    }
    writeJson(ctx.res, 201, await adapter.createAccount(body))
  }

  async function handleSetEnabled(ctx: { req: IncomingMessage; res: ServerResponse; params: Record<string, string> }, enable: boolean): Promise<void> {
    if (!adapter.setEnabled) throw notImplemented('enable/disable')
    await requireAccount(ctx.params.id!)
    const body = await readJsonObject(ctx.req)
    if (typeof body.enabled !== 'boolean') {
      throw errors.terminal('enable/disable require a boolean "enabled" field', { responseStatus: 422 })
    }
    // Body value wins; the URL verb is authoritative when they disagree.
    writeJson(ctx.res, 200, await adapter.setEnabled(ctx.params.id!, enable))
  }

  async function handleModels(ctx: { res: ServerResponse }): Promise<void> {
    if (!adapter.models) throw notImplemented('models')
    let accountId = ''
    try {
      const list = await adapter.listAccounts()
      accountId = (list.find((a) => a.status === 'active') ?? list[0])?.accountId as string | undefined ?? ''
    } catch { /* fall through with empty id */ }
    const result = await adapter.models(accountId)
    writeJson(ctx.res, 200, result)
  }

  async function handleAction(ctx: { req: IncomingMessage; res: ServerResponse; params: Record<string, string> }): Promise<void> {
    if (!adapter.invokeAction) throw notImplemented('actions')
    const actionId = ctx.params.actionId!
    if (!allowedActions.has(actionId)) {
      throw errors.terminal(`undeclared action "${actionId}"`, { responseStatus: 404 })
    }
    const body = await readJsonObject(ctx.req)
    writeJson(ctx.res, 200, await adapter.invokeAction(actionId, body))
  }

  async function handleChat(ctx: { req: IncomingMessage; res: ServerResponse }): Promise<void> {
    const body = await readJsonObject(ctx.req)
    const req = validateChatRequest(body)
    const controller = new AbortController()
    registry.register(req.requestId, req.accountId, controller)

    // Client disconnect ⇒ abort the upstream request and free the slot.
    const onClose = (): void => {
      controller.abort()
      registry.unregister(req.requestId)
    }
    ctx.req.on('close', onClose)
    ctx.res.on('close', onClose)

    const runtime: SdkChatRuntime = {
      accountId: req.accountId,
      requestId: req.requestId,
      deadlineMs: req.deadlineMs,
      signal: controller.signal,
    }

    try {
      if (req.stream) {
        await streamChat(ctx.res, req, runtime, controller)
      } else {
        if (!adapter.chat) throw notImplemented('chat')
        writeJson(ctx.res, 200, await adapter.chat(req, runtime))
      }
    } finally {
      ctx.req.off('close', onClose)
      ctx.res.off('close', onClose)
      registry.unregister(req.requestId)
    }
  }

  async function streamChat(
    res: ServerResponse,
    req: SdkChatRequest,
    runtime: SdkChatRuntime,
    controller: AbortController,
  ): Promise<void> {
    if (!adapter.chatStream) throw notImplemented('chat streaming')
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    let terminalSent = false
    const writeFrame = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
      for await (const chunk of adapter.chatStream(req, runtime)) {
        if (chunk.finishReason) {
          writeFrame('done', { finishReason: chunk.finishReason, ...(chunk.usage ? { usage: chunk.usage } : {}) })
          terminalSent = true
          break
        }
        const frame: Record<string, unknown> = { text: chunk.text }
        if (chunk.reasoning !== undefined) frame.reasoning = chunk.reasoning
        if (chunk.toolCalls !== undefined) frame.toolCalls = chunk.toolCalls
        writeFrame('chunk', frame)
      }
      if (!terminalSent && !controller.signal.aborted) {
        writeFrame('done', { finishReason: 'stop' })
      }
    } catch (error) {
      if (!terminalSent) {
        writeFrame('error', toExtensionError(error).toBody())
      }
    } finally {
      res.end()
    }
  }

  // ── routing ─────────────────────────────────────────────
  const routes: SdkRoute[] = [
    { method: 'GET', path: '/manifest', handler: handleManifest },
    { method: 'GET', path: '/health', handler: handleHealth },
    { method: 'GET', path: '/v1/accounts', handler: async (ctx) => writeJson(ctx.res, 200, { accounts: await adapter.listAccounts() }) },
    { method: 'POST', path: '/v1/accounts', handler: handleCreateAccount },
    { method: 'GET', path: '/v1/accounts/:id', handler: async (ctx) => writeJson(ctx.res, 200, { account: await requireAccount(ctx.params.id!) }) },
    { method: 'POST', path: '/v1/accounts/:id/refresh', handler: async (ctx) => {
      if (!adapter.refresh) throw notImplemented('refresh')
      await requireAccount(ctx.params.id!)
      writeJson(ctx.res, 200, await adapter.refresh(ctx.params.id!))
    } },
    { method: 'POST', path: '/v1/accounts/:id/enable', handler: (ctx) => handleSetEnabled(ctx, true) },
    { method: 'POST', path: '/v1/accounts/:id/disable', handler: (ctx) => handleSetEnabled(ctx, false) },
    { method: 'GET', path: '/v1/accounts/:id/quota', handler: async (ctx) => {
      if (!adapter.quota) throw notImplemented('quota')
      await requireAccount(ctx.params.id!)
      writeJson(ctx.res, 200, await adapter.quota(ctx.params.id!, true))
    } },
    { method: 'POST', path: '/v1/accounts/:id/claim', handler: async (ctx) => {
      if (!adapter.claim) throw notImplemented('claim')
      await requireAccount(ctx.params.id!)
      writeJson(ctx.res, 200, { outcome: await adapter.claim(ctx.params.id!) })
    } },
    { method: 'GET', path: '/v1/models', handler: handleModels },
    { method: 'POST', path: '/v1/chat', handler: handleChat },
    { method: 'POST', path: '/v1/actions/:actionId', handler: handleAction },
  ]

  const openPaths = new Set(['/health', '/manifest'])

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = `req_${Math.random().toString(36).slice(2, 12)}`
    const started = Date.now()
    let status = 500
    let errorKind: string | undefined

    try {
      const parsed = parsePath(req.url ?? '/')
      // Health/manifest stay open so healthchecks and the install handshake
      // work without the token; everything else requires the bearer.
      if (!openPaths.has(parsed.pathname)) checkExtensionAuth(req, opts.authToken)

      const match = matchRoute(routes, req.method ?? 'GET', parsed.pathname)
      if (!match) throw errors.terminal(`no route: ${req.method} ${parsed.pathname}`, { responseStatus: 404 })
      await match.handler({ req, res, params: match.params, requestId })
      status = res.statusCode
    } catch (error) {
      if (error instanceof ExtensionAuthError) {
        status = 401
        errorKind = 'AUTH_INVALID'
        if (!res.headersSent) writeJson(res, 401, { error: { kind: 'AUTH_INVALID', message: error.message } })
      } else {
        const pe = toExtensionError(error)
        status = pe.status()
        errorKind = pe.kind
        if (!res.headersSent) writeJson(res, status, pe.toBody())
        else if (!res.writableEnded) res.end()
      }
    } finally {
      logger?.info('http.request', sanitizeLogFields({
        request_id: requestId,
        method: req.method,
        path: req.url ?? '',
        status,
        duration: Date.now() - started,
        ...(errorKind ? { error_kind: errorKind } : {}),
      }))
    }
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res)
  })
  // expose for graceful-shutdown composition in the extension's index.ts
  ;(server as Server & { __requestRegistry?: RequestRegistry }).__requestRegistry = registry
  return server
}

// ---------------------------------------------------------------------------
// chat request validation (mirror of the extensions' contract)
// ---------------------------------------------------------------------------

export function validateChatRequest(body: Record<string, unknown>): SdkChatRequest {
  if (typeof body.model !== 'string' || body.model.length === 0) throw errors.terminal('chat requires model')
  if (body.model.includes('::')) throw errors.protocolViolation('model id must not carry a provider prefix')
  if (typeof body.accountId !== 'string' || body.accountId.length === 0) {
    throw errors.terminal('chat requires accountId (Core selects the account)')
  }
  if (!Array.isArray(body.messages)) throw errors.terminal('chat requires a messages array')
  const stream = body.stream === true
  const requestId = typeof body.requestId === 'string' && body.requestId.length > 0
    ? body.requestId
    : `req_${Math.random().toString(36).slice(2, 12)}`
  const deadlineMs = typeof body.deadlineMs === 'number' && body.deadlineMs > 0 ? body.deadlineMs : Date.now() + 120_000
  const req: SdkChatRequest = {
    messages: body.messages as SdkChatRequest['messages'],
    model: body.model,
    stream,
    accountId: body.accountId,
    requestId,
    deadlineMs,
  }
  if (typeof body.maxTokens === 'number') req.maxTokens = body.maxTokens
  if (typeof body.temperature === 'number') req.temperature = body.temperature
  if (typeof body.reasoningEffort === 'string') req.reasoningEffort = body.reasoningEffort
  if (Array.isArray(body.tools)) req.tools = body.tools as unknown[]
  return req
}
