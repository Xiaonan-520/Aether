/**
 * Hono application factory: a thin HTTP adapter over the service layer.
 * No business logic lives here — routing, auth middleware, SSE framing and
 * OpenAI error mapping only.
 */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { GatewayConfig } from '../config/index.js'
import type { ServiceContext } from '../service/context.js'
import { ChatService } from '../service/chat-service.js'
import { ModelService } from '../service/model-service.js'
import { AdminService } from '../service/admin-service.js'
import { LoginService } from '../service/login-service.js'
import { parseChatCompletionsRequest, OpenAIApiError } from '../protocol/openai/parse.js'
import {
  serializeChatCompletion,
  serializeChatChunk,
  newStreamContext,
} from '../protocol/openai/serialize.js'
import { toOpenAiErrorBody, toOpenAiStatus } from '../core/errors/normalizer.js'
import { UpstreamError } from '../core/errors/upstream-error.js'

export interface GatewayApp {
  app: Hono
  chat: ChatService
  models: ModelService
  admin: AdminService
  login: LoginService
  listen: (port: number, host: string) => Promise<unknown>
}

/** Constant-time-ish token comparison (small strings; avoids trivial timing). */
function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice(7)
}

export function createGatewayApp(ctx: ServiceContext): GatewayApp {
  const chat = new ChatService(ctx)
  const models = new ModelService(ctx)
  const admin = new AdminService(ctx)
  const login = new LoginService(ctx)

  const app = new Hono()

  // -- health (no auth) -----------------------------------------------------
  app.get('/healthz', (c) => c.json({ ok: true, ts: ctx.now() }))

  // -- auth middleware ------------------------------------------------------
  app.use('/v1/*', async (c, next) => {
    const token = bearerToken(c.req.header('Authorization'))
    if (!token || !tokenEquals(token, ctx.config.gatewayApiKey)) {
      return c.json(
        { error: { message: 'invalid API key', type: 'authentication_error', code: 'invalid_api_key' } },
        401,
      )
    }
    await next()
  })
  app.use('/api/*', async (c, next) => {
    const token = bearerToken(c.req.header('Authorization'))
    if (!token || !tokenEquals(token, ctx.config.gatewayAdminToken)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  })

  // -- OpenAI-compatible /v1 ------------------------------------------------
  app.get('/v1/models', (c) => {
    const list = models.list()
    return c.json(models.toOpenAiList(list))
  })

  app.post('/v1/chat/completions', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      throw new OpenAIApiError(400, 'invalid_request_error', 'request body is not valid JSON')
    }
    const req = parseChatCompletionsRequest(body)
    const outcome = await chat.handle(req)

    if (outcome.kind === 'result') {
      return c.json(serializeChatCompletion(outcome.result, req.model))
    }

    // streaming: SSE with stable id/created across frames
    const streamCtx = newStreamContext(req.model)
    const sse = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder()
        try {
          for await (const chunk of outcome.stream) {
            const frame = serializeChatChunk(chunk, req.model, streamCtx.id, streamCtx.created)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        } catch (err) {
          // mid-stream failure: emit an OpenAI error frame then close
          const error =
            err instanceof UpstreamError
              ? err
              : new UpstreamError({ kind: 'TRANSPORT', message: 'stream failed' })
          const frame = {
            error: toOpenAiErrorBody(error).error,
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        } finally {
          controller.close()
        }
      },
      cancel() {
        // client disconnected; provider stream cleanup happens via its own finally
      },
    })
    return new Response(sse, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  })

  // -- admin /api -----------------------------------------------------------
  app.get('/api/providers', (c) => c.json({ providers: ctx.registry.list().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    capabilities: p.capabilities,
  })) }))

  app.get('/api/accounts', (c) => {
    const provider = c.req.query('provider')
    return c.json({ accounts: admin.listAccounts(provider) })
  })
  app.get('/api/accounts/:id', (c) => c.json(admin.getAccount(c.req.param('id'))))
  app.post('/api/accounts', async (c) => {
    const body = await c.req.json<Record<string, unknown>>()
    const account = await admin.createAccount({
      provider: String(body.provider ?? ''),
      displayName: body.displayName ? String(body.displayName) : undefined,
      credential: body.credential,
      providerMetadata: body.providerMetadata as Record<string, unknown> | undefined,
    })
    return c.json(account, 201)
  })
  app.patch('/api/accounts/:id', async (c) => {
    const body = await c.req.json<Record<string, unknown>>()
    return c.json(admin.patchAccount(c.req.param('id'), body))
  })
  app.delete('/api/accounts/:id', (c) => {
    admin.removeAccount(c.req.param('id'))
    return c.json({ ok: true })
  })
  // -- interactive login (Phase 3B) ----------------------------------------
  // POST /api/accounts/:provider/login       -> start a login, returns the URL
  // GET  /api/accounts/:provider/login/:id   -> poll; persists the credential
  // POST /api/accounts/:provider/captcha     -> operator submits a captcha token
  app.post('/api/accounts/:provider/login', async (c) => {
    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const provider = c.req.param('provider')
    const displayName = typeof body.displayName === 'string' ? body.displayName : undefined
    return c.json(await login.begin(provider, displayName))
  })
  app.get('/api/accounts/:provider/login/:loginId', async (c) => {
    return c.json(await login.poll(c.req.param('provider'), c.req.param('loginId')))
  })
  app.post('/api/accounts/:provider/captcha', async (c) => {
    const provider = c.req.param('provider')
    if (provider !== 'zcode') {
      throw new OpenAIApiError(400, 'invalid_request_error', `provider "${provider}" does not use a captcha`)
    }
    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const verifyParam = typeof body.verify_param === 'string' ? body.verify_param : ''
    if (verifyParam.trim().length === 0) {
      throw new OpenAIApiError(400, 'invalid_request_error', 'verify_param is required')
    }
    ctx.captcha.submit(verifyParam)
    return c.json({ ok: true, provider, expires_in: Math.floor(ctx.captcha.cacheTtl / 1000) })
  })

  app.post('/api/accounts/:id/import-credential', async (c) => {
    const body = await c.req.json<Record<string, unknown>>()
    const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : undefined
    return c.json(admin.importCredential(c.req.param('id'), body.credential, expiresAt ?? null))
  })
  app.get('/api/jobs', (c) => {
    const jobType = c.req.query('type') || undefined
    return c.json({ jobs: admin.listJobs(jobType) })
  })
  app.get('/api/events', (c) => {
    const limit = Number(c.req.query('limit') ?? 50)
    return c.json({ events: admin.listEvents(limit) })
  })

  // -- error handling -------------------------------------------------------
  app.onError((err, c) => {
    if (err instanceof OpenAIApiError) {
      return c.json(
        { error: { message: err.message, type: err.type, code: err.code } },
        err.status as 400 | 401 | 404 | 409 | 429 | 500,
      )
    }
    if (err instanceof UpstreamError) {
      return c.json(toOpenAiErrorBody(err), toOpenAiStatus(err) as 502)
    }
    // unknown: log detail server-side, return generic 500 (no internals leak)
    ctx.store.addEvent({
      ts: ctx.now(), level: 'error', kind: 'http.unhandled',
      message: err instanceof Error ? err.message : String(err),
    })
    return c.json(
      { error: { message: 'internal gateway error', type: 'api_error' } },
      500,
    )
  })

  function listen(port: number, host: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      try {
        const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
          console.log(`gateway listening on http://${host}:${info.port}`)
          resolve(server)
        })
        server.on('error', reject)
      } catch (err) {
        reject(err)
      }
    })
  }

  return { app, chat, models, admin, login, listen }
}
