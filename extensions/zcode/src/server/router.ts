/**
 * ZCode Extension 的 HTTP 路由（Extension Protocol v1）。
 *
 * 以 workbuddycn 的 router 为模板，差异点：
 *  - 登录是两段式：POST /v1/accounts（占位）→ POST /v1/accounts/:id/login
 *    （触发 cli/init，返回 authorizeUrl）→ GET /v1/accounts/:id 轮询推进；
 *  - 新增 POST /v1/accounts/:id/import-credential（运维者粘贴 JWT/API key）；
 *  - 新增 GET /v1/captcha（人工验证码授权页）+ POST /v1/captcha（提交令牌）；
 *  - 新增 DELETE /v1/accounts/:id（修复 workbuddycn 审查发现的删除链路缺口）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AppConfig } from '../util/config.js'
import type { Logger } from '../util/logger.js'
import { MANIFEST } from '../protocol/manifest.js'
import { errors, ProtocolError, toProtocolError } from '../protocol/errors.js'
import type { ExtensionChatRequest } from '../protocol/types.js'
import type { ZCodeProvider } from '../provider/zcode/index.js'
import { checkExtensionAuth, ExtensionAuthError } from './auth.js'
import { ActiveRequestRegistry } from './registry.js'
import { renderCaptchaPage } from '../provider/zcode/captcha-page.js'

export interface RouterOptions {
  config: AppConfig
  logger: Logger
  provider: ZCodeProvider
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
    { method: 'POST', path: '/v1/accounts/:id/login', handler: handleBeginLogin },
    { method: 'POST', path: '/v1/accounts/:id/import-credential', handler: handleImportCredential },
    { method: 'GET', path: '/v1/accounts/:id', handler: handleGetAccount },
    { method: 'POST', path: '/v1/accounts/:id/refresh', handler: handleRefresh },
    { method: 'POST', path: '/v1/accounts/:id/enable', handler: handleEnable },
    { method: 'POST', path: '/v1/accounts/:id/disable', handler: handleDisable },
    { method: 'DELETE', path: '/v1/accounts/:id', handler: handleDeleteAccount },
    { method: 'GET', path: '/v1/accounts/:id/quota', handler: handleQuota },
    { method: 'GET', path: '/v1/models', handler: handleModels },
    { method: 'POST', path: '/v1/chat', handler: handleChat },
    { method: 'POST', path: '/v1/actions/:actionId', handler: handleAction },
    { method: 'GET', path: '/v1/captcha', handler: handleCaptchaPage },
    { method: 'POST', path: '/v1/captcha', handler: handleCaptchaSubmit },
  ]

  function handleManifest(ctx: Ctx): void {
    writeJson(ctx.res, 200, MANIFEST)
  }

  function handleHealth(ctx: Ctx): void {
    const status = opts.health ? opts.health().status : 'healthy'
    void provider.listAccounts().then((accounts) => {
      const usable = accounts.filter((a) => a.status === 'active' && a.metadata.credentialKind !== 'none').length
      writeJson(ctx.res, 200, {
        status,
        version: MANIFEST.extension.version,
        accounts: { total: accounts.length, usable },
      })
    }).catch(() => {
      writeJson(ctx.res, 200, { status: 'degraded', version: MANIFEST.extension.version, accounts: { total: 0, usable: 0 } })
    })
  }

  async function handleListAccounts(ctx: Ctx): Promise<void> {
    const accounts = await provider.listAccounts()
    writeJson(ctx.res, 200, { accounts })
  }

  async function handleCreateAccount(ctx: Ctx): Promise<void> {
    const body = await readJsonObject(ctx.req)
    // 凭据字段在结构化通道上被禁止（RFC §10.3）——它们只走 import 端点
    const forbidden = ['access_token', 'refresh_token', 'password', 'api_key', 'secret', 'token', 'jwt_token']
    for (const key of forbidden) {
      if (key in body) {
        throw errors.protocolViolation(`credential field "${key}" is forbidden in account creation; use POST /v1/accounts/:id/import-credential`)
      }
    }
    const accountId = typeof body.accountId === 'string' && body.accountId.length > 0 ? body.accountId : undefined
    const displayName = typeof body.displayName === 'string' ? body.displayName : undefined
    const result = await provider.createAccount({ accountId, displayName })
    logger.info('account.create', { request_id: ctx.requestId, account_id: result.accountId })
    writeJson(ctx.res, 201, result)
  }

  /** 触发 OAuth CLI init，返回官方授权 URL。 */
  async function handleBeginLogin(ctx: Ctx): Promise<void> {
    const id = ctx.params.id!
    const result = await provider.beginLogin(id)
    logger.info('login.begin', { request_id: ctx.requestId, account_id: id })
    writeJson(ctx.res, 200, {
      accountId: id,
      authorizationUrl: result.authorizeUrl,
      expiresIn: result.expiresIn,
      pollInterval: result.pollInterval,
    })
  }

  /** 运维者导入现成凭据（JWT / API key）。 */
  async function handleImportCredential(ctx: Ctx): Promise<void> {
    const id = ctx.params.id!
    const body = await readJsonObject(ctx.req)
    const result = await provider.importCredential(id, body)
    logger.info('account.import', { request_id: ctx.requestId, account_id: id })
    writeJson(ctx.res, 200, { accountId: id, ...result })
  }

  async function handleGetAccount(ctx: Ctx): Promise<void> {
    const account = await provider.getAccount(ctx.params.id!)
    if (!account) throw errors.terminal(`unknown account ${ctx.params.id}`, { responseStatus: 404 })
    writeJson(ctx.res, 200, { account })
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
    const result = await provider.setEnabled(id, enable)
    writeJson(ctx.res, 200, { accountId: id, accepted: result.accepted, status: result.status })
  }

  async function handleDeleteAccount(ctx: Ctx): Promise<void> {
    const id = ctx.params.id!
    const account = await provider.getAccount(id)
    if (!account) throw errors.terminal(`unknown account ${id}`, { responseStatus: 404 })
    await provider.deleteAccount(id)
    logger.info('account.delete', { request_id: ctx.requestId, account_id: id })
    writeJson(ctx.res, 200, { accountId: id, deleted: true })
  }

  async function handleQuota(ctx: Ctx): Promise<void> {
    const id = ctx.params.id!
    const account = await provider.getAccount(id)
    if (!account) throw errors.terminal(`unknown account ${id}`, { responseStatus: 404 })
    const quota = await provider.quota(id, true)
    writeJson(ctx.res, 200, quota)
  }

  async function handleModels(ctx: Ctx): Promise<void> {
    const accounts = await provider.listAccounts()
    const accountId = accounts.find((a) => a.status === 'active')?.accountId ?? accounts[0]?.accountId ?? ''
    const { models, source } = await provider.models(accountId)
    logger.info('models.list', { request_id: ctx.requestId, account_id: accountId, source, count: models.length })
    writeJson(ctx.res, 200, { models })
  }

  async function handleChat(ctx: Ctx): Promise<void> {
    const body = await readJsonObject(ctx.req)
    const req = validateChatRequest(body)
    const controller = new AbortController()
    registry.register(ctx.requestId, req.accountId, controller)
    const onClose = (): void => {
      controller.abort()
      registry.unregister(ctx.requestId)
    }
    ctx.req.on('close', onClose)
    ctx.res.on('close', onClose)

    try {
      if (req.stream) {
        await streamChat(ctx, req, controller)
      } else {
        const result = await provider.chat(req, {
          accountId: req.accountId, requestId: ctx.requestId, deadlineMs: req.deadlineMs, signal: controller.signal,
        })
        writeJson(ctx.res, 200, result)
      }
    } finally {
      ctx.req.off('close', onClose)
      ctx.res.off('close', onClose)
      registry.unregister(ctx.requestId)
      provider.touchCaptcha()
    }
  }

  async function streamChat(
    ctx: Ctx,
    req: ExtensionChatRequest,
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
      for await (const chunk of provider.chatStream(req, {
        accountId: req.accountId, requestId: ctx.requestId, deadlineMs: req.deadlineMs, signal: controller.signal,
      })) {
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
    if (actionId === 'submit-captcha') {
      const param = typeof body.verify_param === 'string' ? body.verify_param : ''
      if (!param) throw errors.terminal('verify_param is required', { responseStatus: 422 })
      provider.getCaptcha().submit(param)
      logger.info('captcha.submit.action', { request_id: ctx.requestId })
      writeJson(ctx.res, 200, { actionId, result: { ok: true } })
      return
    }
    if (actionId === 'refresh-quota') {
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
    throw errors.terminal(`action "${actionId}" is declared but not implemented`, { responseStatus: 501 })
  }

  /** 人工验证码授权页（官方 widget）。免鉴权以便直接在浏览器打开。 */
  function handleCaptchaPage(ctx: Ctx): void {
    void provider.getCaptcha().fetchConfig().then((cfg) => {
      const html = renderCaptchaPage({
        prefix: cfg.prefix,
        region: cfg.region,
        sceneId: cfg.sceneId,
        scriptUrl: `https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`,
        submitPath: '/v1/captcha',
      })
      ctx.res.statusCode = 200
      ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8')
      ctx.res.end(html)
    }).catch(() => {
      writeJson(ctx.res, 502, { error: { kind: 'UPSTREAM_5XX', message: 'captcha config unavailable' } })
    })
  }

  /** 提交人工完成的 verifyParam（需要扩展 Bearer）。 */
  async function handleCaptchaSubmit(ctx: Ctx): Promise<void> {
    const body = await readJsonObject(ctx.req)
    const param = typeof body.verify_param === 'string' ? body.verify_param
      : typeof body.verifyParam === 'string' ? body.verifyParam
      : ''
    if (!param) throw errors.terminal('verify_param is required', { responseStatus: 422 })
    provider.getCaptcha().submit(param)
    logger.info('captcha.submit', { request_id: ctx.requestId })
    writeJson(ctx.res, 200, { ok: true })
  }

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
      const pathname = parsePath(req.url ?? '/').pathname
      // /health 与 /v1/captcha（GET 页面）免鉴权；提交令牌需要 Bearer
      if (pathname !== '/health' && !(req.method === 'GET' && pathname === '/v1/captcha')) {
        checkExtensionAuth(req, config.authToken)
      }
      const parsed = parsePath(req.url ?? '/')
      const match = matchRoute(routes, req.method ?? 'GET', parsed.pathname)
      if (!match) throw errors.terminal(`no route: ${req.method} ${parsed.pathname}`, { responseStatus: 404 })
      ctx.params = match.params
      await match.handler(ctx)
      status = res.statusCode
    } catch (error) {
      if (error instanceof ExtensionAuthError) {
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
    if (ok) return { handler: route.handler, params: params }
  }
  return undefined
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
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
  const requestId = typeof body.requestId === 'string' && body.requestId.length > 0
    ? body.requestId
    : `req_${Math.random().toString(36).slice(2, 12)}`
  const deadlineMs = typeof body.deadlineMs === 'number' && body.deadlineMs > 0 ? body.deadlineMs : Date.now() + 120_000
  const req: ExtensionChatRequest = {
    messages: body.messages as ExtensionChatRequest['messages'],
    model: body.model,
    stream,
    accountId: body.accountId,
    requestId: requestId,
    deadlineMs: deadlineMs,
  }
  if (typeof body.maxTokens === 'number') req.maxTokens = body.maxTokens
  if (typeof body.temperature === 'number') req.temperature = body.temperature
  if (typeof body.reasoningEffort === 'string') req.reasoningEffort = body.reasoningEffort
  if (Array.isArray(body.tools)) req.tools = body.tools as ExtensionChatRequest['tools']
  return req
}
