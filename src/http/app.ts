/**
 * Hono application factory: a thin HTTP adapter over the service layer.
 * No business logic lives here — routing, auth middleware, SSE framing and
 * OpenAI error mapping only.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GatewayConfig } from '../config/index.js'
import type { ServiceContext } from '../service/context.js'
import { ChatService } from '../service/chat-service.js'
import { ModelService } from '../service/model-service.js'
import { AdminService } from '../service/admin-service.js'
import { ConsoleService } from '../service/console-service.js'
import { ExtensionService } from '../service/extension-service.js'
import { LoginService } from '../service/login-service.js'
import { ApiKeyService } from '../service/api-key-service.js'
import { AdminAuthService, AuthError, type AdminUserView } from '../service/admin-auth-service.js'
import { parseChatCompletionsRequest, OpenAIApiError } from '../protocol/openai/parse.js'
import {
  serializeChatCompletion,
  serializeChatChunk,
  newStreamContext,
} from '../protocol/openai/serialize.js'
import { toOpenAiErrorBody, toOpenAiStatus } from '../core/errors/normalizer.js'
import { UpstreamError } from '../core/errors/upstream-error.js'
import { AmbiguousModelError } from '../core/router/model-router.js'
import { renderAuthorizePage, widgetParams } from '../providers/zcode/captcha/index.js'

export interface GatewayApp {
  app: Hono
  chat: ChatService
  models: ModelService
  admin: AdminService
  login: LoginService
  apiKeys: ApiKeyService
  adminAuth: AdminAuthService
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

/** Admin identity attached by the /api guard when a session token was used. */
type AuthUserView = AdminUserView

/** Context variable set by the admin guard; absent for the static env token. */
declare module 'hono' {
  interface ContextVariableMap {
    adminUser: AdminUserView | undefined
  }
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Expiry of the session behind this request, or null for the static token. */
function sessionExpiryOf(c: Context, auth: AdminAuthService): number | null {
  const token = bearerToken(c.req.header('Authorization'))
  if (!token) return null
  return auth.sessionExpiry(token)
}

export function createGatewayApp(ctx: ServiceContext): GatewayApp {
  const chat = new ChatService(ctx)
  const models = new ModelService(ctx)
  const admin = new AdminService(ctx)
  const consoleService = new ConsoleService(ctx)
  const login = new LoginService(ctx)
  const apiKeys = new ApiKeyService(ctx)
  const adminAuth = new AdminAuthService(ctx)

  // Extension management (docs/EXTENSION_LIFECYCLE.md §5): only wired when the
  // operator configured the Extension Manager endpoint. The manager token
  // stays server-side; the browser only ever talks to these /api routes.
  let extensions: ExtensionService | undefined
  if (ctx.extensionManager) {
    extensions = new ExtensionService({
      endpoint: ctx.extensionManager,
      ctx: () => ctx,
    })
  }

  const app = new Hono()

  // -- health (no auth) -----------------------------------------------------
  app.get('/healthz', (c) => c.json({ ok: true, ts: ctx.now() }))

  // -- auth middleware ------------------------------------------------------
  // /v1/* accepts the bootstrap GATEWAY_API_KEY (unchanged, checked first) and
  // any issued API key created through POST /api/keys.
  app.use('/v1/*', async (c, next) => {
    const token = bearerToken(c.req.header('Authorization'))
    const ok =
      token !== null &&
      (tokenEquals(token, ctx.config.gatewayApiKey) || apiKeys.verify(token))
    if (!ok) {
      return c.json(
        { error: { message: 'invalid API key', type: 'authentication_error', code: 'invalid_api_key' } },
        401,
      )
    }
    await next()
  })
  // Public auth endpoints: no admin credential required. They are registered
  // BEFORE the /api guard and matched by exact method+path, so the guard below
  // never sees them (Hono runs middleware in registration order).
  app.get('/api/auth/status', (c) => {
    const token = bearerToken(c.req.header('Authorization'))
    const user = token ? adminAuth.authenticate(token) : undefined
    return c.json(adminAuth.status(user))
  })
  app.post('/api/auth/register', async (c) => {
    const body = await readJsonObject(c)
    return c.json(await adminAuth.register(body), 201)
  })
  app.post('/api/auth/login', async (c) => {
    const body = await readJsonObject(c)
    return c.json(await adminAuth.login(body))
  })

  app.use('/api/*', async (c, next) => {
    // Two independent credentials are accepted here, in this order:
    //   1. the static GATEWAY_ADMIN_TOKEN from the environment (unchanged
    //      operator/automation path; all existing tooling keeps working)
    //   2. a live admin session token issued by /api/auth/login (or /register)
    // A gateway API key (`gw-…`) and extension hop tokens are never valid here.
    const token = bearerToken(c.req.header('Authorization'))
    if (!token) return c.json({ error: 'unauthorized' }, 401)
    if (tokenEquals(token, ctx.config.gatewayAdminToken)) {
      await next()
      return
    }
    const sessionUser = adminAuth.authenticate(token)
    if (!sessionUser) return c.json({ error: 'unauthorized' }, 401)
    c.set('adminUser', sessionUser)
    await next()
  })

  // Session lifecycle (admin credential required; placed after the guard).
  app.get('/api/auth/me', (c) => {
    const user = c.get('adminUser') as AuthUserView | undefined
    return c.json({
      user: user ?? null,
      // true when the caller used the static env token rather than a session
      staticToken: user === undefined,
      expiresAt: sessionExpiryOf(c, adminAuth),
    })
  })
  app.post('/api/auth/logout', (c) => {
    const token = bearerToken(c.req.header('Authorization'))
    // Revoking a static env token is meaningless (and impossible): report the
    // no-op honestly instead of pretending a session was destroyed.
    if (token && !tokenEquals(token, ctx.config.gatewayAdminToken)) {
      adminAuth.logout(token)
    }
    return c.json({ ok: true })
  })
  app.post('/api/auth/password', async (c) => {
    const user = c.get('adminUser') as AuthUserView | undefined
    if (!user) {
      // The static env token has no account behind it, so there is nothing to
      // change. Say so instead of pretending the password was updated.
      throw new AuthError(400, 'invalid_request', 'the static admin token has no password; sign in with an admin account')
    }
    const body = await readJsonObject(c)
    return c.json(await adminAuth.changePassword(user, body))
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
  // live model sync for a provider (same path the login flow uses; lets an
  // operator reconcile the model table after an extension upgrade)
  app.post('/api/providers/:id/sync-models', async (c) => {
    const provider = c.req.param('id')
    const accounts = ctx.store.listAccounts(provider).filter((s) => s.account.authenticated)
    if (accounts.length === 0) {
      throw new OpenAIApiError(409, 'invalid_request_error', `no authenticated account for provider "${provider}"`)
    }
    const synced = await login.syncModels(provider, accounts[0].account)
    return c.json({ provider, models_synced: synced })
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
  // GET  /captcha/zcode                       -> human captcha authorization page
  //                                              (no secrets embedded; admin
  //                                              token is entered in the page)
  app.post('/api/accounts/:provider/login', async (c) => {
    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const provider = c.req.param('provider')
    const displayName = typeof body.displayName === 'string' ? body.displayName : undefined
    // phone is only used by sms-login providers; other providers ignore it
    const phone = typeof body.phone === 'string' ? body.phone : undefined
    return c.json(await login.begin(provider, displayName, phone))
  })
  app.get('/api/accounts/:provider/login/:loginId', async (c) => {
    return c.json(await login.poll(c.req.param('provider'), c.req.param('loginId')))
  })
  // POST /api/accounts/:provider/login/:id/credential
  //   Finish a login that cannot complete by polling alone: the body carries the
  //   provider-specific payload (auth code / refresh token / AK-SK). The adapter
  //   performs the exchange; the service persists the returned credential.
  app.post('/api/accounts/:provider/login/:loginId/credential', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const payload = body.credential !== undefined ? body.credential : body
    return c.json(await login.submitCredential(c.req.param('provider'), c.req.param('loginId'), payload))
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

  // Human captcha authorization page. Sits outside /api/* auth on purpose:
  // the HTML embeds no secrets — the operator pastes the admin token into the
  // page (or ?token= pre-fills it) and the browser posts it to the protected
  // submit endpoint above.
  app.get('/captcha/zcode', async (c) => {
    const config = await ctx.captcha.fetchConfig()
    const widget = widgetParams(config)
    const html = renderAuthorizePage({ ...widget, submitPath: '/api/accounts/zcode/captcha' })
    return c.html(html)
  })

  app.post('/api/accounts/:id/import-credential', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    // A ready credential blob is required here; a bare/missing body is a client
    // error, not a 500 from the encryption layer.
    const credential = body.credential
    if (credential === undefined || credential === null || typeof credential !== 'object') {
      throw new OpenAIApiError(
        400,
        'invalid_request_error',
        'missing "credential" object in request body',
      )
    }
    const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : undefined
    return c.json(admin.importCredential(c.req.param('id'), credential, expiresAt ?? null))
  })
  app.get('/api/jobs', (c) => {
    const jobType = c.req.query('type') || undefined
    return c.json({ jobs: admin.listJobs(jobType) })
  })

  // -- console aggregation endpoints (admin token) --------------------------
  app.get('/api/console/overview', (c) => c.json(consoleService.getOverview()))
  app.get('/api/console/providers/:id/models', (c) =>
    c.json({ models: consoleService.listProviderModels(c.req.param('id')) }),
  )
  app.get('/api/console/providers/:id/quotas', (c) =>
    c.json({ quotas: consoleService.listProviderQuotas(c.req.param('id')) }),
  )
  app.get('/api/console/providers/:id/claims', (c) => {
    const limit = Number(c.req.query('limit') ?? 50)
    return c.json({ claims: consoleService.listProviderClaims(c.req.param('id'), limit) })
  })

  // -- manual maintenance triggers (admin token) ----------------------------
  // Enqueue a scheduler job for one account. The scheduler owns retry,
  // concurrency and idempotency; the console never bypasses it.
  app.post('/api/accounts/:id/refresh', (c) => {
    return c.json(admin.enqueueAccountJob(ctx, c.req.param('id'), 'token_refresh'))
  })
  app.post('/api/accounts/:id/quota-sync', (c) => {
    return c.json(admin.enqueueAccountJob(ctx, c.req.param('id'), 'quota_sync'))
  })
  // Manual check-in trigger: same queue + idempotency as the recurring scan
  // (scheduler-executors closes the day after the first real attempt, so
  // repeated clicks cannot storm the upstream). Blocked for providers that
  // do not declare supportsCredits.
  app.post('/api/accounts/:id/credit-claim', (c) => {
    return c.json(admin.enqueueAccountJob(ctx, c.req.param('id'), 'credit_claim'))
  })
  // Read-only claim history for one account: last recorded outcome today,
  // from the same credit_claims rows the scheduler writes.
  app.get('/api/accounts/:id/credit-claim', (c) => {
    return c.json({ claims: admin.accountClaims(ctx, c.req.param('id')) })
  })
  app.get('/api/events', (c) => {
    const limit = Number(c.req.query('limit') ?? 50)
    return c.json({ events: admin.listEvents(limit) })
  })

  // -- issued gateway API keys (admin token; inherits the /api/* middleware) --
  // The full key is returned by POST only; GET never exposes key or hash.
  // The creator is recorded when the caller signed in with an admin account;
  // a caller using the static GATEWAY_ADMIN_TOKEN has no account, so the key
  // is stored with a null owner.
  app.post('/api/keys', async (c) => {
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({} as Record<string, unknown>))
    const creator = (c.get('adminUser') as AuthUserView | undefined)?.id ?? null
    return c.json(apiKeys.create({ name: body.name, expiresAt: body.expiresAt }, creator), 201)
  })
  app.get('/api/keys', (c) => c.json({ keys: apiKeys.list() }))
  app.delete('/api/keys/:id', (c) => c.json(apiKeys.remove(c.req.param('id'))))

  // -- error handling -------------------------------------------------------
  app.onError((err, c) => {
    if (err instanceof AuthError) {
      // Auth failures carry a machine-readable code but never internal detail.
      return c.json({ error: err.code, message: err.message }, err.status)
    }
    if (err instanceof AmbiguousModelError) {
      // bare model id matched several providers: tell the client how to disambiguate
      return c.json(
        { error: { message: err.message, type: 'invalid_request_error', code: 'model_ambiguous' } },
        400,
      )
    }
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

  // -- web console (static build; no auth on the HTML itself) ---------------
  // Serves ../dist-console when `npm run console:build` has produced it. The
  // SPA talks to /api/* with the operator's admin token entered in-app, so the
  // HTML/JS are safe to serve unauthenticated — they carry no secrets. Hash
  // routing means only /console/ itself needs to resolve; /api and /v1 keep
  // their middleware regardless of path order.
  if (existsSync(join(process.cwd(), 'dist-console', 'index.html'))) {
    app.use(
      '/console/*',
      serveStatic({
        root: 'dist-console',
        rewriteRequestPath: (p) => p.replace(/^\/console/, '') || '/',
      }),
    )
    app.get('/console', (c) => c.redirect('/console/'))
  }

  // -- extension lifecycle routes (admin token; docs/EXTENSION_LIFECYCLE.md §5)
  // Inert unless GATEWAY_EXTENSION_MANAGER_URL/TOKEN are configured. Core
  // injects the manager token server-side; there is no generic proxy route.
  if (extensions) {
    app.get('/api/console/extensions', async (c) =>
      jsonOrError(c, { extensions: await extensions!.list() }))
    app.get('/api/console/extensions/available', async (c) =>
      jsonOrError(c, await extensions!.available()))
    app.post('/api/console/extensions/install', async (c) =>
      jsonOrError(c, await extensions!.install(await readBody(c) as { manifest: unknown; image?: { repo: string; tag: string; digest?: string } })))
    // Install by image name only: Core probes the image for its manifest, so
    // the console never asks an operator to handle JSON by hand (KI-001).
    app.post('/api/console/extensions/install-from-image', async (c) =>
      jsonOrError(c, await extensions!.installFromImage(await readBody(c) as { image?: { repo?: string; tag?: string; digest?: string } })))
    app.post('/api/console/extensions/:id/upgrade', async (c) =>
      jsonOrError(c, await extensions!.upgrade(c.req.param('id'), await readBody(c) as { manifest: unknown; image?: { repo: string; tag: string; digest?: string } })))
    app.post('/api/console/extensions/:id/stop', async (c) =>
      jsonOrError(c, await extensions!.stop(c.req.param('id'))))
    app.post('/api/console/extensions/:id/restart', async (c) =>
      jsonOrError(c, await extensions!.restart(c.req.param('id'))))
    app.post('/api/console/extensions/:id/remove', async (c) =>
      jsonOrError(c, await extensions!.remove(c.req.param('id'))))
    app.post('/api/console/extensions/:id/reload', async (c) =>
      jsonOrError(c, await extensions!.reload(c.req.param('id'))))
    app.get('/api/console/extensions/:id', async (c) =>
      jsonOrError(c, await extensions!.detail(c.req.param('id'))))
    app.get('/api/console/extensions/:id/providers/:providerId/actions', async (c) =>
      jsonOrError(c, {
        actions: await extensions!.listActions(c.req.param('id'), c.req.param('providerId')),
      }))
    app.post('/api/console/extensions/:id/providers/:providerId/actions/:actionId', async (c) =>
      jsonOrError(c, await extensions!.invokeAction(
        c.req.param('id'),
        c.req.param('providerId'),
        c.req.param('actionId'),
        await readBody(c) as { accountId?: string; payload?: unknown },
      )))
  }

  async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
    try {
      return await c.req.json()
    } catch {
      return {}
    }
  }

  async function jsonOrError(c: Context, promise: unknown): Promise<Response> {
    try {
      const body = await Promise.resolve(promise)
      return c.json(body ?? { ok: true })
    } catch (err) {
      if (err instanceof OpenAIApiError) {
        return c.json(
          { error: { code: err.code ?? err.type, message: err.message } },
          err.status as 400,
        )
      }
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'internal_error', message } }, 500)
    }
  }

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

  return { app, chat, models, admin, login, apiKeys, adminAuth, listen }
}
