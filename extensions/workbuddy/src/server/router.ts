/**
 * Phase 3 Extension Protocol HTTP router.
 *
 * Endpoints (see docs/PROTOCOL_CONTRACT.md):
 *   GET  /manifest
 *   GET  /health
 *   GET  /v1/accounts
 *   GET  /v1/accounts/:id
 *   POST /v1/accounts
 *   POST /v1/accounts/:id/refresh
 *   POST /v1/accounts/:id/enable|disable
 *   GET  /v1/accounts/:id/quota
 *   POST /v1/accounts/:id/claim
 *   GET  /v1/models
 *   POST /v1/chat            (JSON or SSE)
 *   POST /v1/actions/:actionId  (only if declared in the manifest)
 *
 * HTTP concerns live here; WorkBuddy logic is delegated to the provider facade.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AppConfig } from '../util/config.js'
import type { Logger } from '../util/logger.js'
import { MANIFEST } from '../protocol/manifest.js'
import { errors, ProtocolError, toProtocolError } from '../protocol/errors.js'
import type {
  AccountStatus, ChatChunk, CreateAccountRequest, ExtensionAccount, ExtensionChatRequest,
} from '../protocol/types.js'
import { ACCOUNT_STATUSES } from '../protocol/types.js'
import type { WorkBuddyProvider } from '../provider/workbuddy/index.js'
import { checkExtensionAuth, ExtensionAuthError } from './auth.js'
import { ActiveRequestRegistry } from './registry.js'

export interface RouterOptions {
  config: AppConfig
  logger: Logger
  provider: WorkBuddyProvider
  registry: ActiveRequestRegistry
  health?: () => { status: 'healthy' | 'degraded' | 'unhealthy' }
}

interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  requestId: string
}

interface Route {
  method: string
  path: string
  handler: (ctx: Ctx) => Promise<void> | void
}

export function createExtensionServer(opts: RouterOptions) {
  const { config, logger, provider, registry } = opts

  const routes: Route[] = [
    { method: 'GET', path: '/manifest', handler: handleManifest },
    { method: 'GET', path: '/health', handler: handleHealth },
    { method: 'GET', path: '/v1/accounts', handler: handleListAccounts },
    { method: 'POST', path: '/v1/accounts', handler: handleCreateAccount },
    { method: 'GET', path: '/v1/accounts/:id', handler: handleGetAccount },
    { method: 'POST', path: '/v1/accounts/:id/refresh', handler: handleRefresh },
    { method: 'POST', path: '/v1/accounts/:id/enable', handler: handleEnable },
    { method: 'POST', path: '/v1/accounts/:id/disable', handler: handleDisable },
    { method: 'GET', path: '/v1/accounts/:id/quota', handler: handleQuota },
    { method: 'POST', path: '/v1/accounts/:id/claim', handler: handleClaim },
    { method: 'GET', path: '/v1/models', handler: handleModels },
    { method: 'POST', path: '/v1/chat', handler: handleChat },
    { method: 'POST', path: '/v1/actions/:actionId', handler: handleAction },
  ]

  // ── manifest / health ───────────────────────────────────
  function handleManifest(ctx: Ctx): void {
    writeJson(ctx.res, 200, MANIFEST)
  }

  function handleHealth(ctx: Ctx): void {
    const status = opts.health ? opts.health().status : 'healthy'
    void provider.listAccounts().then((accounts) => {
      const usable = accounts.filter((a) => a.status === 'active').length
      writeJson(ctx.res, 200, {
        status,
        version: MANIFEST.extension.version,
        accounts: { total: accounts.length, usable },
      })
    }).catch(() => {
      writeJson(ctx.res, 200, { status: 'degraded', version: MANIFEST.extension.version, accounts: { total: 0, usable: 0 } })
    })
  }

  // ── accounts ────────────────────────────────────────────
  async function handleListAccounts(ctx: Ctx): Promise<void> {
    const accounts = await provider.listAccounts()
    writeJson(ctx.res, 200, { accounts })
  }

  async function handleGetAccount(ctx: Ctx): Promise<void> {
    const account = await provider.getAccount(ctx.params.id!)
    if (!account) throw errors.terminal(`unknown account ${ctx.params.id}`, { responseStatus: 404 })
    writeJson(ctx.res, 200, { account })
  }

  async function handleCreateAccount(ctx: Ctx): Promise<void> {
    const body = await readJsonObject(ctx.req)
    // Credential fields are forbidden on this channel (RFC §10.3).
    const forbidden = ['access_token', 'refresh_token', 'password', 'api_key', 'secret', 'token']
    for (const key of forbidden) {
      if (key in body) {
        throw errors.protocolViolation(`credential field "${key}" is forbidden in account creation`)
      }
    }
    const loginMode = typeof body.loginMode === 'string' ? body.loginMode : undefined
    if (loginMode !== 'external-link') {
      throw errors.terminal('only loginMode "external-link" is supported', { responseStatus: 422 })
    }
    const accountId = typeof body.accountId === 'string' && body.accountId.length > 0 ? body.accountId : undefined
    const displayName = typeof body.displayName === 'string' ? body.displayName : undefined
    const result = await provider.createAccount({ accountId, displayName })
    logger.info('account.create', { request_id: ctx.requestId, account_id: result.accountId })
    writeJson(ctx.res, 201, result)
  }

  async function handleRefresh(ctx: Ctx): Promise<void> {
    const id = ctx.params.id!
    const result = await provider.refresh(id)
    logger.info('account.refresh', { request_id: ctx.requestId, account_id: id, refreshed: result.refreshed })
    writeJson(ctx.res, 200, result)
  }

  async function handleEnable(ctx: Ctx): Promise<void> {
    await setEnabled(ctx, true)
  }

  async function handleDisable(ctx: Ctx): Promise<void> {
    await setEnabled(ctx, false)
  }

  async function setEnabled(ctx: Ctx, enable: boolean): Promise<void> {
    const id = ctx.params.id!
    const body = await readJsonObject(ctx.req)
    if (typeof body.enabled !== 'boolean') {
      throw errors.terminal('enable/disable require a boolean "enabled" field', { responseStatus: 422 })
    }
    // Body value wins; the URL verb is authoritative when they disagree.
    const enabled = enable
    const result = await provider.setEnabled(id, enabled)
    writeJson(ctx.res, 200, { accountId: id, accepted: result.accepted, status: result.status })
  }

  async function handleQuota(ctx: Ctx): Promise<void> {
    const id = ctx.params.id!
    const account = await provider.getAccount(id)
    if (!account) throw errors.terminal(`unknown account ${id}`, { responseStatus: 404 })
    const quota = await provider.quota(id, true)
    writeJson(ctx.res, 200, quota)
  }

  // ── models ──────────────────────────────────────────────
  // ── claim ───────────────────────────────────────────────
  async function handleClaim(ctx: Ctx): Promise<void> {
    const id = ctx.params.id!
    const account = await provider.getAccount(id)
    if (!account) throw errors.terminal(`unknown account ${id}`, { responseStatus: 404 })
    const outcome = await provider.claim(id)
    writeJson(ctx.res, 200, { outcome })
  }

  async function handleModels(ctx: Ctx): Promise<void> {
    const accounts = await provider.listAccounts()
    const accountId = accounts.find((a) => a.status === 'active')?.accountId ?? accounts[0]?.accountId ?? ''
    const { models, source } = await provider.models(accountId)
    logger.info('models.list', { request_id: ctx.requestId, account_id: accountId, source, count: models.length })
    writeJson(ctx.res, 200, { models })
  }

  // ── chat ────────────────────────────────────────────────
  async function handleChat(ctx: Ctx): Promise<void> {
    const body = await readJsonObject(ctx.req)
    const req = validateChatRequest(body)
    const controller = new AbortController()
    registry.register(ctx.requestId, req.accountId, controller)

    // Client disconnect ⇒ abort the upstream request and free the registry slot.
    // Both the request and the response 'close' events are observed so a socket
    // teardown is caught regardless of which side Node reports first.
    const onClose = (): void => {
      controller.abort()
      registry.unregister(ctx.requestId)
    }
    ctx.req.on('close', onClose)
    ctx.res.on('close', onClose)

    const deadlineMs = req.deadlineMs
    const ctxRuntime = { accountId: req.accountId, requestId: ctx.requestId, deadlineMs, signal: controller.signal }

    try {
      if (req.stream) {
        await streamChat(ctx, req, ctxRuntime, controller)
      } else {
        const result = await provider.chat(req, ctxRuntime)
        writeJson(ctx.res, 200, result)
      }
    } finally {
      ctx.req.off('close', onClose)
      ctx.res.off('close', onClose)
      registry.unregister(ctx.requestId)
    }
  }

  async function streamChat(
    ctx: Ctx,
    req: ExtensionChatRequest,
    runtime: { accountId: string; requestId: string; deadlineMs: number; signal: AbortSignal },
    controller: AbortController,
  ): Promise<void> {
    ctx.res.statusCode = 200
    ctx.res.setHeader('Content-Type', 'text/event-stream')
    ctx.res.setHeader('Cache-Control', 'no-cache')
    ctx.res.setHeader('Connection', 'keep-alive')
    ctx.res.flushHeaders?.()

    const started = Date.now()
    let terminalSent = false
    const writeFrame = (event: string, data: unknown): void => {
      ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
      for await (const chunk of provider.chatStream(req, runtime)) {
        if (chunk.finishReason) {
          writeFrame('done', { finishReason: chunk.finishReason, ...(chunk.usage ? { usage: chunk.usage } : {}) })
          terminalSent = true
          break
        }
        const frame: ChatChunk = { text: chunk.text }
        if (chunk.reasoning !== undefined) frame.reasoning = chunk.reasoning
        if (chunk.toolCalls !== undefined) frame.toolCalls = chunk.toolCalls
        writeFrame('chunk', frame)
      }
      if (!terminalSent && !controller.signal.aborted) {
        writeFrame('done', { finishReason: 'stop' })
        terminalSent = true
      }
    } catch (error) {
      if (!terminalSent) {
        const pe = toProtocolError(error)
        writeFrame('error', pe.toBody())
        terminalSent = true
      }
    } finally {
      logger.info('chat.stream', {
        request_id: ctx.requestId, account_id: req.accountId, model: req.model,
        duration: Date.now() - started, status: terminalSent ? 'done' : 'aborted',
      })
      ctx.res.end()
    }
  }

  // ── actions ─────────────────────────────────────────────
  async function handleAction(ctx: Ctx): Promise<void> {
    const actionId = ctx.params.actionId!
    const declared = MANIFEST.providers.some((p) => (p.actions ?? []).some((a) => a.id === actionId))
    if (!declared) throw errors.terminal(`undeclared action "${actionId}"`, { responseStatus: 404 })

    const body = await readJsonObject(ctx.req)
    const accountId = typeof body.accountId === 'string' && body.accountId.length > 0
      ? body.accountId
      : typeof body.account_id === 'string' && body.account_id.length > 0
        ? body.account_id
        : undefined

    switch (actionId) {
      case 'refresh-quota': {
        let target = accountId
        if (!target) {
          const accounts = await provider.listAccounts()
          target = accounts[0]?.accountId
        }
        if (!target) {
          writeJson(ctx.res, 200, { accountId: null, resources: [], checkedAt: new Date().toISOString(), source: 'authoritative' })
          return
        }
        const quota = await provider.quota(target, false)
        writeJson(ctx.res, 200, quota)
        return
      }
      default:
        throw errors.terminal(`action "${actionId}" is declared but not implemented`, { responseStatus: 501 })
    }
  }

  // ── request lifecycle ───────────────────────────────────
  const server = createServer((req, res) => {
    void handleRequest(req, res)
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = `req_${Math.random().toString(36).slice(2, 12)}`
    const ctx: Ctx = { req, res, params: {}, requestId }
    const started = Date.now()
    let status = 500
    let errorKind: string | undefined

    try {
      // Health is open so a container healthcheck works without the token.
      const pathname = parsePath(req.url ?? '/').pathname
      if (pathname !== '/health') checkExtensionAuth(req, config.authToken)

      const parsed = parsePath(req.url ?? '/')
      const match = matchRoute(routes, req.method ?? 'GET', parsed.pathname)
      if (!match) throw errors.terminal(`no route: ${req.method} ${parsed.pathname}`, { responseStatus: 404 })
      ctx.params = match.params
      await match.handler(ctx)
      status = res.statusCode
    } catch (error) {
      if (error instanceof ExtensionAuthError) {
        // Core↔Extension credential mismatch after a token rotation. Reported as
        // EXTENSION_AUTH (not AUTH_INVALID) so Core re-registers instead of
        // parking the provider account as token_expired.
        status = 401
        errorKind = 'EXTENSION_AUTH'
        if (!res.headersSent) writeJson(res, 401, { error: { kind: 'EXTENSION_AUTH', message: error.message } })
      } else {
        const pe = toProtocolError(error)
        status = pe.status()
        errorKind = pe.kind
        if (!res.headersSent) writeJson(res, status, pe.toBody())
        else if (!res.writableEnded) res.end()
      }
    } finally {
      logger.info('http.request', {
        request_id: requestId,
        method: req.method,
        path: req.url ?? '',
        status,
        duration: Date.now() - started,
        ...(errorKind ? { error_kind: errorKind } : {}),
      })
    }
  }

  return server
}

// ── helpers ────────────────────────────────────────────────

export function parsePath(raw: string): { pathname: string; query: string } {
  const q = raw.indexOf('?')
  return q === -1 ? { pathname: raw, query: '' } : { pathname: raw.slice(0, q), query: raw.slice(q + 1) }
}

export function matchRoute(
  routes: Route[],
  method: string,
  pathname: string,
): { handler: Route['handler']; params: Record<string, string> } | undefined {
  const segments = pathname.split('/').filter((s) => s.length > 0)
  for (const route of routes) {
    if (route.method !== method) continue
    const routeSegments = route.path.split('/').filter((s) => s.length > 0)
    if (routeSegments.length !== segments.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < routeSegments.length; i++) {
      const rs = routeSegments[i]!
      const ss = segments[i]!
      if (rs.startsWith(':')) params[rs.slice(1)] = decodeURIComponent(ss)
      else if (rs !== ss) { ok = false; break }
    }
    if (ok) return { handler: route.handler, params }
  }
  return undefined
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) throw errors.terminal('body must be a JSON object')
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    throw errors.terminal('invalid JSON body')
  }
}

export function validateChatRequest(body: Record<string, unknown>): ExtensionChatRequest {
  if (typeof body.model !== 'string' || body.model.length === 0) throw errors.terminal('chat requires model')
  if (body.model.includes('::')) throw errors.protocolViolation('model id must not carry a provider prefix')
  if (typeof body.accountId !== 'string' || body.accountId.length === 0) {
    throw errors.terminal('chat requires accountId (Core selects the account)')
  }
  if (!Array.isArray(body.messages)) throw errors.terminal('chat requires a messages array')
  const stream = body.stream === true
  const requestId = typeof body.requestId === 'string' && body.requestId.length > 0 ? body.requestId : `req_${Math.random().toString(36).slice(2, 12)}`
  const deadlineMs = typeof body.deadlineMs === 'number' && body.deadlineMs > 0 ? body.deadlineMs : Date.now() + 120_000
  const req: ExtensionChatRequest = {
    messages: body.messages as ExtensionChatRequest['messages'],
    model: body.model,
    stream,
    accountId: body.accountId,
    requestId,
    deadlineMs,
  }
  if (typeof body.maxTokens === 'number') req.maxTokens = body.maxTokens
  if (typeof body.temperature === 'number') req.temperature = body.temperature
  if (typeof body.reasoningEffort === 'string') req.reasoningEffort = body.reasoningEffort
  if (Array.isArray(body.tools)) req.tools = body.tools as ExtensionChatRequest['tools']
  return req
}

/** Re-exported for tests. */
export { ACCOUNT_STATUSES }
export type { AccountStatus, ExtensionAccount }
