/**
 * Fake (echo) Extension — the Phase 2 test extension (RFC §九/§十/§十一).
 *
 * Implements Extension Protocol v1 over HTTP for the sole purpose of
 * validating: Manager lifecycle → protocol endpoints → conformance →
 * RemoteProvider → chat. It is NOT a real provider: the `echo` provider has
 * one model `echo-1` that echoes the request back, one self-generated in-
 * memory account, and one pure-test manual action.
 *
 * Compliance notes:
 *  - no CAPTCHA logic at all; `manual-test` is a form/browser round-trip
 *    fixture with no solver, shell, fs, docker or proxy semantics;
 *  - the (fake) credential lives only in this process — nothing about it is
 *    ever sent to Core; account ids are opaque.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { ExtensionManifest } from '../../protocol/extension/manifest.js'

// ---------------------------------------------------------------------------
// the fake manifest — echo provider with a manual-test action pair
// ---------------------------------------------------------------------------

export const FAKE_MANIFEST: ExtensionManifest = {
  apiVersion: '1.0',
  extension: {
    id: 'fake',
    version: '1.0.0',
    displayName: 'Fake Echo Extension',
    description: 'Phase 2 test extension: echo provider + manual-test action fixture',
    author: 'xiaonan-520',
    license: 'MIT',
  },
  runtime: {
    port: 8080,
    healthPath: '/health',
    env: [{ name: 'LOG_LEVEL', required: false, default: 'info' }],
    volumes: [{ name: 'state', mountPath: '/data', purpose: 'test state' }],
    resources: { memory: '128Mi', cpus: '0.25' },
  },
  security: {
    permissions: {
      network: { domains: [] },
      filesystem: 'named-volumes-only',
      capabilities: [],
      privileged: false,
    },
  },
  providers: [
    {
      id: 'echo',
      displayName: 'Echo',
      protocol: 'openai-chat',
      capabilities: {
        supportsOAuth: false,
        supportsRefreshToken: false,
        supportsQuota: true,
        supportsCredits: false,
        supportsStreaming: true,
        supportsVision: false,
        supportsToolCall: false,
        supportsMultipleAccounts: true,
        needsCaptcha: false,
        loginMode: 'import',
        protocol: 'openai-chat',
      },
      fallbackModels: [{ id: 'echo-1', name: 'Echo 1', capabilities: { streaming: true } }],
      actions: [
        {
          id: 'manual-test-start',
          httpMethod: 'GET',
          title: 'Start manual test',
          mode: 'read',
          sideEffects: 'none',
          ui: 'browser',
          outputSchema: { type: 'object', properties: { challenge: { type: 'string' } }, required: ['challenge'] },
        },
        {
          id: 'manual-test-submit',
          httpMethod: 'POST',
          title: 'Submit manual test result',
          mode: 'write',
          sideEffects: 'one-shot',
          ui: 'form',
          inputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
          outputSchema: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'] },
        },
      ],
      accountFields: [],
    },
  ],
}

// ---------------------------------------------------------------------------
// in-process state — the extension's "own store" (credential boundary: stays here)
// ---------------------------------------------------------------------------

interface FakeAccount {
  accountId: string
  status: 'active' | 'needs_manual_action'
  displayName: string
  /** FAKE credential — exists only inside this process, never serialized out */
  credential: { kind: 'fake'; secret: string }
  lastError: string | null
}

const state = {
  startedAt: Date.now(),
  accounts: new Map<string, FakeAccount>(),
  /** behavior switches the suite/tests toggle via env */
  behavior: {
    healthStatus: 'healthy' as 'healthy' | 'degraded' | 'unhealthy',
    /** delay (ms) applied to /v1/chat to exercise timeout detection */
    chatDelayMs: 0,
    /** serve a manifest that differs from the installed one (handshake check) */
    corruptManifest: false,
  },
  pendingActions: new Map<string, { challenge: string }>(),
}

function ensureAccount(): FakeAccount {
  const existing = [...state.accounts.values()][0]
  if (existing) return existing
  const account: FakeAccount = {
    accountId: `echo-${randomUUID().slice(0, 8)}`,
    status: 'active',
    displayName: 'Echo test account',
    credential: { kind: 'fake', secret: randomUUID() },
    lastError: null,
  }
  state.accounts.set(account.accountId, account)
  return account
}

// ---------------------------------------------------------------------------
// protocol endpoint implementations
// ---------------------------------------------------------------------------

function handleManifest(): unknown {
  return state.behavior.corruptManifest
    ? { ...structuredClone(FAKE_MANIFEST), extension: { ...FAKE_MANIFEST.extension, version: '9.9.9-corrupted' } }
    : FAKE_MANIFEST
}

function handleHealth(): unknown {
  return {
    status: state.behavior.healthStatus,
    uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
    version: FAKE_MANIFEST.extension.version,
    accounts: { total: state.accounts.size, usable: state.behavior.healthStatus === 'healthy' ? state.accounts.size : 0 },
  }
}

function handleModels(): unknown {
  return {
    models: [{ id: 'echo-1', name: 'Echo 1', capabilities: { vision: false, toolCall: false, streaming: true } }],
  }
}

function handleListAccounts(): unknown {
  ensureAccount()
  return {
    accounts: [...state.accounts.values()].map((a) => ({
      accountId: a.accountId,
      providerId: 'echo',
      displayName: a.displayName,
      status: a.status,
      manualAction: a.status === 'needs_manual_action'
        ? {
            kind: 'other',
            instructions: 'Open the manual test challenge, copy the answer token, submit it.',
            actions: [
              { actionId: 'manual-test-start', label: 'Open challenge', method: 'GET' as const },
              { actionId: 'manual-test-submit', label: 'Submit answer', method: 'POST' as const },
            ],
          }
        : null,
      quota: {
        accountId: a.accountId,
        resources: [{
          id: 'echo_calls', kind: 'requests', remaining: 1000, total: 1000, used: 0,
          unit: 'requests', resetAt: null, status: 'ok', metadata: { source: 'test' },
        }],
        checkedAt: new Date().toISOString(),
        source: 'authoritative' as const,
      },
      lastError: a.lastError,
      lastSuccessAt: new Date().toISOString(),
      lastFailureAt: null,
      metadata: {},
    })),
  }
}

function handleChat(body: Record<string, unknown>): unknown {
  const lastUser = String(
    (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => (m as { role?: string }).role === 'user')
      .map((m) => (m as { content?: string }).content ?? '')
      .pop() ?? '',
  )
  if (body.stream === true) return { __sse: true, text: `echo: ${lastUser}` }
  return {
    content: `echo: ${lastUser}`,
    finishReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 2 },
  }
}

/** manual-test actions: browser round-trip with a challenge token. */
function handleAction(actionId: string, body: Record<string, unknown>, method: string): { status: number; body: unknown } {
  if (actionId === 'manual-test-start') {
    if (method !== 'GET') return { status: 405, body: errorBody('TERMINAL', 'manual-test-start is GET') }
    const challenge = randomUUID()
    state.pendingActions.set(challenge, { challenge })
    return { status: 200, body: { result: { challenge, html: `<html><body>challenge: ${challenge}</body></html>` } } }
  }
  if (actionId === 'manual-test-submit') {
    if (method !== 'POST') return { status: 405, body: errorBody('TERMINAL', 'manual-test-submit is POST') }
    const answer = String((body.payload as Record<string, unknown> | undefined)?.answer ?? '')
    const pending = state.pendingActions.get(answer)
    if (!pending) {
      return { status: 200, body: { result: { accepted: false } } }
    }
    state.pendingActions.delete(answer)
    return { status: 200, body: { result: { accepted: true } } }
  }
  // undeclared / unknown actions are rejected — conformance domain 9 asserts this
  return { status: 404, body: errorBody('TERMINAL', `action "${actionId}" is not declared`) }
}

function errorBody(kind: string, message: string): unknown {
  return { error: { kind, message } }
}

// ---------------------------------------------------------------------------
// HTTP server + auth
// ---------------------------------------------------------------------------

export interface FakeExtensionHandle {
  server: Server
  port: number
  endpointUrl: string
  state: typeof state
  manifest: ExtensionManifest
}

export async function startFakeExtension(port = 0, env: Record<string, string> = {}): Promise<FakeExtensionHandle> {
  const token = env.GATEWAY_EXTENSION_TOKEN

  const server = createServer((req, res) => {
    void route(req, res, token).catch((err) => {
      send(res, 500, errorBody('TERMINAL', err instanceof Error ? err.message : String(err)))
    })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      resolve({
        server,
        port: actualPort,
        endpointUrl: `http://127.0.0.1:${actualPort}`,
        state,
        manifest: FAKE_MANIFEST,
      })
    })
  })
}

async function route(req: IncomingMessage, res: ServerResponse, token: string | undefined): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://fake.internal')
  const path = url.pathname

  // extension auth: manager-issued token on protocol routes (manifest/health
  // stay open pre-handshake for the manager's waitHealthy, matching RFC §17.2
  // where the token gates protocol data but the manager must observe boot)
  const needsAuth = !['/manifest', '/health'].includes(path)
  if (needsAuth && token) {
    const presented = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (presented !== token) {
      send(res, 401, errorBody('AUTH_INVALID', 'bad extension token'))
      return
    }
  }

  if (req.method === 'GET' && path === '/manifest') return send(res, 200, handleManifest())
  if (req.method === 'GET' && path === '/health') return send(res, 200, handleHealth())
  if (req.method === 'GET' && path === '/v1/models') return send(res, 200, handleModels())

  if (req.method === 'GET' && path === '/v1/accounts') return send(res, 200, handleListAccounts())
  if (req.method === 'POST' && path === '/v1/accounts') {
    const body = await readJson(req) as Record<string, unknown> | undefined
    // credential boundary fixture: any credential-ish field is rejected loudly
    if (body && ['access_token', 'refresh_token', 'password', 'api_key', 'secret'].some((k) => k in body)) {
      send(res, 400, errorBody('PROTOCOL_VIOLATION', 'credential fields are forbidden in account creation (RFC §10.3)'))
      return
    }
    const account = ensureAccount()
    send(res, 201, {
      accountId: account.accountId,
      status: 'pending',
      authorizationUrl: null,
      expiresIn: null,
      pollInterval: null,
    })
    return
  }
  const accountMatch = /^\/v1\/accounts\/([A-Za-z0-9-]+)(?:\/(refresh|quota|claim|enable|disable))?$/.exec(path)
  if (accountMatch) {
    const [, accountId, op] = accountMatch
    const account = state.accounts.get(accountId)
    if (!account) return send(res, 404, errorBody('TERMINAL', `unknown account ${accountId}`))
    if (!op) return send(res, 200, { account: accountProjection(account) })
    if (op === 'quota') {
      return send(res, 200, {
        accountId,
        resources: [{ id: 'echo_calls', kind: 'requests', remaining: 1000, total: 1000, used: 0, unit: 'requests', resetAt: null, status: 'ok' }],
        checkedAt: new Date().toISOString(),
        source: 'authoritative',
      })
    }
    if (op === 'refresh') return send(res, 200, { status: account.status, refreshed: false, error: null })
    if (op === 'enable' || op === 'disable') {
      return send(res, 200, { accountId, accepted: true, status: account.status })
    }
    if (op === 'claim') return send(res, 200, { outcome: { kind: 'unsupported', message: 'echo has no credits' } })
  }

  if (req.method === 'POST' && path === '/v1/chat') {
    const body = await readJson(req) as Record<string, unknown>
    if (state.behavior.chatDelayMs > 0) await sleep(state.behavior.chatDelayMs)
    const result = handleChat(body)
    if (typeof result === 'object' && result !== null && '__sse' in result) {
      // stream=true: emit canonical SSE frames (chunk → done)
      const sseText = String((result as Record<string, unknown>).text)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: chunk\ndata: ${JSON.stringify({ text: sseText })}\n\n`)
      res.write(`event: done\ndata: ${JSON.stringify({ finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2 } })}\n\n`)
      res.end()
      return
    }
    return send(res, 200, result)
  }

  const actionMatch = /^\/v1\/actions\/([a-z0-9-]+)$/.exec(path)
  if (actionMatch) {
    const body = req.method === 'POST' ? await readJson(req) as Record<string, unknown> : {}
    const out = handleAction(actionMatch[1], body ?? {}, req.method ?? 'GET')
    return send(res, out.status, out.body)
  }

  send(res, 404, errorBody('TERMINAL', `no such route ${req.method} ${path}`))
}

function accountProjection(a: FakeAccount): unknown {
  return {
    accountId: a.accountId,
    providerId: 'echo',
    displayName: a.displayName,
    status: a.status,
    manualAction: null,
    quota: null,
    lastError: a.lastError,
    lastSuccessAt: new Date().toISOString(),
    lastFailureAt: null,
    metadata: {},
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Local runtime boot contract: run(port, env). */
export async function run(port: number, env: Record<string, string> = {}): Promise<void> {
  await startFakeExtension(port, env)
  // keep the process alive
  await new Promise(() => undefined)
}
