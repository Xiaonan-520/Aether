/**
 * CodeBuddy Extension (RFC v2 §24 — provider migration into an extension).
 *
 * One image serves both buddy-family products that remain built-in today:
 * codebuddy (mainland, copilot.tencent.com) and buddy-intl (international,
 * www.codebuddy.ai). The runtime picks the product from CODEBUDDY_PRODUCT;
 * the manifest provider id always comes from the real product config —
 * same pattern as the TRAE extension. Install twice via the Extension
 * Manager for the two instances.
 *
 * Full provider surface: external-link polling login (auth/state → auth/token
 * → login/account), silent token refresh with rotation, model discovery
 * (/v3/config), OpenAI-compatible chat (SSE aggregated for non-stream
 * clients), upstream error mapping, honest quota (unknown unless the product
 * proves otherwise) and daily check-in claim.
 *
 * Credential boundary: credentials live in this extension's encrypted store;
 * protocol payloads carry NO credential material; account ids are
 * Core-allocated opaque strings (§10.3).
 *
 * Protocol primitives are reused verbatim from `src/providers/shared/buddy/*`
 * (same code the built-in adapters ran) — no new upstream behaviour.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  BuddyRefreshExpiredError,
  buildCredential,
  credentialAuthHeaders,
  credentialExpiresAtMs,
  fetchAuthState,
  fetchBuddyModels,
  isRefreshable,
  parseAccountData,
  parseTokenData,
  pollAccountOnce,
  pollTokenOnce,
  refreshBuddyToken,
  type BuddyCredential,
} from '../../providers/shared/buddy/protocol.js'
import { CHAT_PATH, HTTP_HEADER_DOMAIN } from '../../providers/shared/buddy/constants.js'
import { CODEBUDDY, BUDDY_INTL, resolveUserAgent, type BuddyProduct } from '../../providers/shared/buddy/product.js'
import { claimDailyCheckin, fetchCheckinStatus } from '../../providers/shared/buddy/credits.js'
import { fetchMeterQuota } from '../../providers/shared/buddy/meter.js'
import { decodeSseStream } from '../../protocol/openai/sse.js'
import { CodeBuddyCredentialStore } from './credential-store.js'
import type { ExtensionManifest } from '../../protocol/extension/manifest.js'
import type { ChatChunk } from '../../core/types.js'

const LOGIN_TTL_MS = 5 * 60 * 1000

export interface CodeBuddyExtensionOptions {
  port?: number
  dataDir?: string
  secret?: string
  fetcher?: typeof fetch
  /** product override; defaults to the mainland product (codebuddy) */
  product?: BuddyProduct
  /** overrides the manifest extension id (e.g. 'buddy-intl' for the intl image install) */
  extensionId?: string
  now?: () => number
}

/**
 * The manifest declares the real upstream quota semantics (§13.1): the buddy
 * meter has no per-account remaining/total numbers we can read, so the
 * extension reports NO fabricated fields — quota stays `known: false` unless
 * a resource is genuinely observable. The check-in credit claim is a flow,
 * not a balance.
 */
function codebuddyManifestFor(product: BuddyProduct, extensionId?: string): ExtensionManifest {
  // the extension id defaults to the real product id — never a hard-coded literal
  const extId = (extensionId ?? product.id) === 'buddy-intl' ? 'buddy-intl' : 'codebuddy'
  return {
    apiVersion: '1.0',
    extension: {
      id: extId,
      version: '1.0.3',
      displayName: product.displayName,
      description: `CodeBuddy-family provider extension (${product.id}) — external-link login, chat, check-in credit`,
      license: 'MIT',
    },
    runtime: {
      port: 8080,
      healthPath: '/health',
      env: [
        { name: 'LOG_LEVEL', required: false, default: 'info' },
        { name: 'CODEBUDDY_PRODUCT', required: false, default: 'codebuddy' },
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
          supportsVision: true,
          supportsToolCall: true,
          supportsMultipleAccounts: true,
          needsCaptcha: false,
          loginMode: 'external-link',
          protocol: 'openai-chat',
        },
        fallbackModels: product.fallbackModels.map((m) => ({
          id: m.id,
          name: m.name,
          capabilities: { vision: true, toolCall: true, streaming: true },
        })),
        // Declarative quota contract (§13.1): the billing meter exposes N
        // credit packages per account, each with remaining/total/used and a
        // cycle end (resetAt). All four numeric fields are upstream-provided.
        quotaResources: [
          {
            id: 'pkg-*',
            kind: 'credits',
            unit: 'credits',
            displayName: 'Credit packages (per active package)',
            fields: { remaining: true, total: true, used: true, resetAt: true },
          },
        ],
        // Read-only action surface (conformance manual-actions domain):
        // check-in activity status — no side effects, no credential egress.
        actions: [
          {
            id: 'checkin-status',
            httpMethod: 'POST',
            title: 'Read check-in activity status',
            mode: 'read',
            sideEffects: 'none',
            ui: 'none',
            inputSchema: {
              type: 'object',
              properties: {
                account_id: { type: 'string' },
              },
            },
            outputSchema: {
              type: 'object',
              properties: {
                active: { type: 'boolean' },
                todayCheckedIn: { type: 'boolean' },
                streakDays: { type: 'number' },
              },
            },
          },
        ],
      },
    ],
  }
}

export const CODEBUDDY_MANIFEST = codebuddyManifestFor(CODEBUDDY)

interface LoginSession {
  state: string
  authUrl: string
  startedAt: number
}

export async function startCodeBuddyExtension(opts: CodeBuddyExtensionOptions = {}): Promise<{
  server: Server
  port: number
  endpointUrl: string
  store: CodeBuddyCredentialStore
  manifest: ExtensionManifest
}> {
  const fetcher = opts.fetcher ?? fetch
  const now = opts.now ?? Date.now
  const dataDir = opts.dataDir ?? '/data'
  const secret = opts.secret ?? process.env.GATEWAY_EXTENSION_SECRET ?? 'dev-only-insecure-secret'
  const product = opts.product ?? (process.env.CODEBUDDY_PRODUCT === 'buddy-intl' ? BUDDY_INTL : CODEBUDDY)
  const manifest = codebuddyManifestFor(product, opts.extensionId ?? product.id)
  const store = new CodeBuddyCredentialStore(dataDir, secret)
  const sessions = new Map<string, LoginSession>() // accountId → pending login

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

  function expired(accountId: string): boolean {
    const c = store.get(accountId)
    if (!c) return true
    const at = credentialExpiresAtMs(c)
    return typeof at === 'number' && at <= now()
  }

  // -- upstream operations ---------------------------------------------------

  /**
   * Buddy upstream rejects requests whose first message is not a system
   * prompt (code 11128); prepend a neutral default only when missing.
   * `stream` is always true upstream (code 11101 otherwise); a non-streaming
   * client is served by aggregating the SSE here.
   */
  async function upstreamChat(accountId: string, body: Record<string, unknown>): Promise<Response> {
    const credential = store.get(accountId)
    if (!credential) throwUp('AUTH_INVALID', 'account has no CodeBuddy credential')
    const rawModel = typeof body.model === 'string' ? body.model : ''
    const sep = rawModel.indexOf('::')
    const model = sep > 0 ? rawModel.slice(sep + 2) : rawModel // upstream gets the bare id, never the namespace
    const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []
    const withSystem = messages.length > 0 && messages[0]?.role === 'system'
      ? messages
      : [{ role: 'system', content: 'You are a helpful assistant.' }, ...messages]
    const payload: Record<string, unknown> = { model, messages: withSystem, stream: true }
    if (typeof body.max_tokens === 'number') payload.max_tokens = body.max_tokens
    if (typeof body.temperature === 'number') payload.temperature = body.temperature
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      // Core sends canonical tools ({name, description, parameters}); the
      // upstream speaks OpenAI function-calling and silently ignores unknown
      // tool shapes (HTTP 200, no tool_calls ever). Same mapping as the buddy
      // built-in provider; OpenAI-shaped entries pass through untouched.
      payload.tools = (body.tools as Array<Record<string, unknown>>).map((tool) =>
        tool && typeof tool === 'object' && 'function' in tool
          ? tool
          : { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters ?? {} } },
      )
    }
    const res = await fetcher(`${product.endpoint}${CHAT_PATH}`, {
      method: 'POST',
      headers: {
        ...credentialAuthHeaders(credential, product),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Product-Code': product.productCode,
        'X-Agent-Purpose': 'conversation',
        'X-IDE-Name': product.attributionName,
        'X-IDE-Type': product.attributionName,
        'X-IDE-Version': product.clientVersion,
        'X-Product': product.attributionName,
        'User-Agent': resolveUserAgent(product, model),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      const c = classify(res.status, `CodeBuddy chat failed (HTTP ${res.status})${text ? `: ${text}` : ''}`)
      throwUp(c.kind, c.message, res.status)
    }
    return res
  }

  async function modelsFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    let remote: Array<{ id: string; name: string }> = []
    if (credential) {
      try {
        remote = await fetchBuddyModels(product, credential, fetcher)
      } catch {
        remote = []
      }
    }
    const source = remote.length > 0 ? remote : product.fallbackModels.map((m) => ({ ...m }))
    return {
      models: source.map((m) => ({
        id: m.id,
        name: m.name,
        capabilities: { vision: true, toolCall: true, streaming: true },
      })),
    }
  }

  /**
   * Quota snapshot (§13): reads the Tencent cloud billing meter
   * (get-user-resource) and maps every ACTIVE package to its own resource
   * line (remaining/total/used/unit/resetAt all upstream-provided). Expired
   * or unparseable packages are omitted — never zero-filled.
   */
  async function quotaFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    if (!credential) {
      return { accountId, resources: [], checkedAt: new Date().toISOString(), source: 'authoritative' }
    }
    try {
      const meter = await fetchMeterQuota(product, credential, fetcher)
      return {
        accountId,
        resources: meter.resources,
        checkedAt: new Date().toISOString(),
        source: 'authoritative',
        ...(meter.error !== undefined ? { error: meter.error } : {}),
        ...(meter.summary ? { summary: meter.summary } : {}),
      }
    } catch (err) {
      return { accountId, resources: [], checkedAt: new Date().toISOString(), source: 'authoritative', error: (err as Error).message }
    }
  }

  /** Silent refresh; the upstream rotates the refresh token on every call. */
  async function refreshFor(accountId: string): Promise<{ status: string; refreshed: boolean; error?: string }> {
    const credential = store.get(accountId)
    if (!credential) return { status: 'auth_failed', refreshed: false, error: 'no credential' }
    try {
      const token = await refreshBuddyToken(product, credential, fetcher)
      const next = buildCredential(token, {
        uid: credential.user_id,
        nickname: credential.nickname,
        enterpriseId: credential.enterprise_id,
        accountType: credential.account_type,
      })
      store.put(accountId, next, credential.nickname || null)
      return { status: 'active', refreshed: true }
    } catch (err) {
      if (err instanceof BuddyRefreshExpiredError) {
        return { status: 'auth_failed', refreshed: false, error: `refresh token expired: ${err.message}` }
      }
      return { status: 'auth_failed', refreshed: false, error: (err as Error).message }
    }
  }

  /** Check-in claim: authoritative status read first, single claim call. */
  async function claimFor(accountId: string): Promise<unknown> {
    const credential = store.get(accountId)
    if (!credential) return { outcome: { kind: 'needs_auth', message: 'no credential' } }
    const status = await fetchCheckinStatus(product, credential, fetcher)
    if (!status) return { outcome: { kind: 'failed', message: 'could not read check-in status' } }
    if (!status.active) return { outcome: { kind: 'not_available', message: 'check-in activity is not active' } }
    if (status.todayCheckedIn) return { outcome: { kind: 'already_claimed', message: 'already checked in today' } }
    return { outcome: await claimDailyCheckin(product, credential, fetcher) }
  }

  // -- protocol projection ---------------------------------------------------

  function accountsProjection(): unknown {
    return {
      accounts: store.list().map((rec) => {
        const unusable = !store.isEnabled(rec.accountId) || expired(rec.accountId)
        return {
          accountId: rec.accountId,
          providerId: product.id,
          displayName: rec.displayName ?? rec.accountId,
          status: !store.isEnabled(rec.accountId) ? 'disabled' : unusable ? 'auth_failed' : 'active',
          manualAction: null,
          quota: null, // fetched on demand via /quota
          lastError: unusable ? 'credential expired; refresh or re-login' : null,
          lastSuccessAt: new Date(rec.updatedAt).toISOString(),
          lastFailureAt: null,
          metadata: { refreshable: isRefreshable(rec.credential) },
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

    if (req.method === 'GET' && path === '/manifest') return send(res, 200, manifest)
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { status: 'healthy', version: manifest.extension.version, accounts: { total: store.list().length, usable: store.list().filter((r) => store.isEnabled(r.accountId)).length } })
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
      if (store.has(requested) || sessions.has(requested)) {
        return send(res, 409, { error: { kind: 'TERMINAL', message: `account ${requested} already exists` } })
      }
      // external-link login: the operator completes the official CodeBuddy
      // authorization page; the extension polls auth/token + login/account.
      const { state, authUrl } = await fetchAuthState(product, fetcher)
      sessions.set(requested, { state, authUrl, startedAt: now() })
      return send(res, 201, {
        accountId: requested,
        status: 'pending',
        authorizationUrl: authUrl,
        expiresIn: Math.floor(LOGIN_TTL_MS / 1000),
        pollInterval: 1,
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
          // advance the login state machine: token poll → account poll → store
          try {
            const token = await pollTokenOnce(product, session.state, fetcher)
            if (token.ready && token.token) {
              const account = await pollAccountOnce(product, session.state, token.token.accessToken, fetcher)
              const accountData = account.ready && account.account
                ? account.account
                : { uid: '', nickname: '', enterpriseId: '', accountType: 'personal' }
              const credential = buildCredential(token.token, accountData)
              store.put(accountId, credential, credential.nickname || null)
              sessions.delete(accountId)
            } else if (now() - session.startedAt > LOGIN_TTL_MS) {
              sessions.delete(accountId)
              return send(res, 200, { account: { accountId, providerId: product.id, displayName: accountId, status: 'auth_failed', manualAction: null, quota: null, lastError: 'login timed out', lastSuccessAt: null, lastFailureAt: new Date().toISOString(), metadata: {} } })
            }
          } catch (err) {
            return send(res, 200, { account: { accountId, providerId: product.id, displayName: accountId, status: 'auth_failed', manualAction: null, quota: null, lastError: (err as Error).message, lastSuccessAt: null, lastFailureAt: new Date().toISOString(), metadata: {} } })
          }
        }
        const accounts = (accountsProjection() as { accounts: Array<{ accountId: string }> }).accounts
        const projected = accounts.find((a) => a.accountId === accountId)
        if (projected) return send(res, 200, { account: projected })
        return send(res, 200, {
          account: {
            accountId,
            providerId: product.id,
            displayName: accountId,
            status: 'pending',
            manualAction: null,
            quota: null,
            lastError: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            metadata: { awaiting: 'external-authorization' },
          },
        })
      }
      if (op === 'quota') return send(res, 200, await quotaFor(accountId))
      if (op === 'refresh') return send(res, 200, await refreshFor(accountId))
      if (op === 'claim') return send(res, 200, await claimFor(accountId))
      if (op === 'enable' || op === 'disable') {
        const accepted = store.setEnabled(accountId, op === 'enable')
        const rec = store.list().find((r) => r.accountId === accountId)
        const status = !accepted ? 'unknown' : !rec!.enabled ? 'disabled' : expired(accountId) ? 'auth_failed' : 'active'
        return send(res, 200, { accountId, accepted, status })
      }
    }

    if (req.method === 'POST' && path === '/v1/actions/checkin-status') {
      const body = await readJson(req) as { payload?: { account_id?: unknown } } | undefined
      const payload = (body?.payload ?? {}) as Record<string, unknown>
      const accountId = typeof payload.account_id === 'string' ? payload.account_id : store.list()[0]?.accountId ?? ''
      const credential = store.get(accountId)
      if (!credential) return send(res, 200, { result: { active: false, todayCheckedIn: false, streakDays: 0, error: 'no credential' } })
      const status = await fetchCheckinStatus(product, credential, fetcher)
      return send(res, 200, { result: status ? { active: status.active, todayCheckedIn: status.todayCheckedIn, streakDays: status.streakDays } : { active: false, todayCheckedIn: false, streakDays: 0, error: 'status unavailable' } })
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
      // Fold streamed tool_calls (indexed fragments) into complete calls for
      // the non-streaming client — otherwise finish_reason='tool_calls'
      // arrives with no actionable calls.
      const toolOrder: number[] = []
      const toolMap = new Map<number, { id?: string; name?: string; arguments: string }>()
      try {
        const upstream = await upstreamChat(accountId, body)
        for await (const chunk of decodeSseStream(upstream.body as unknown as AsyncIterable<Uint8Array>)) {
          content += chunk.text
          if (chunk.reasoning) reasoning += chunk.reasoning
          if (chunk.finishReason) finishReason = chunk.finishReason
          if (chunk.usage) usage = chunk.usage as Record<string, unknown>
          if (chunk.toolCalls) {
            for (const call of chunk.toolCalls) {
              // decodeSseStream emits per-frame fragments: the first frame of a
              // call carries id+name, argument deltas follow on later frames
              // with no id. A fragment with no id continues the last call.
              const last = toolOrder.length > 0 ? toolMap.get(toolOrder[toolOrder.length - 1]) : undefined
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
      if (toolOrder.length > 0) {
        out.toolCalls = toolOrder.map((i) => toolMap.get(i)!)
      }
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

/** Local runtime boot contract: run(port, env). */
export async function run(port: number, env: Record<string, string> = {}): Promise<void> {
  await startCodeBuddyExtension({
    port,
    secret: env.GATEWAY_EXTENSION_SECRET,
    product: env.CODEBUDDY_PRODUCT === 'buddy-intl' ? BUDDY_INTL : CODEBUDDY,
  })
  await new Promise(() => undefined)
}

// Re-exported for tests / tooling / multi-instance installs that want the
// exact product typing and per-product manifest assembly (trae pattern).
export { CODEBUDDY, BUDDY_INTL, HTTP_HEADER_DOMAIN, parseTokenData, parseAccountData, codebuddyManifestFor }
