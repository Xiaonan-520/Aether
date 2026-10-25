/**
 * Fake WorkBuddyCN upstream — a configurable HTTP server that emulates the
 * Tencent CodeBuddy CN endpoints so the whole protocol can be tested without
 * real credentials or network access to Tencent.
 *
 * Supports scripting: login flow, refresh, models, quota, chat, streaming,
 * and fault injection (timeout / 401 / 429 / 500 / malformed responses).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export type ChatScript =
  | { kind: 'json'; status: number; body: Record<string, unknown> }
  | { kind: 'error'; status: number; body: Record<string, unknown> }

export interface FakeBehaviour {
  /** When set, /v2/chat/completions returns this status + error JSON. */
  chatStatus?: number
  /** Streaming chat script override (frames). Default is three deltas + [DONE]. */
  chatScript?: () => { kind: 'stream'; frames: string[] } | ChatScript
  /** Hang the chat stream (write headers then never end). */
  chatHangSecs?: number
  delayMs?: number
  tokenNeverReady?: boolean
  tokenReadyAfterPolls?: number
  malformedChat?: boolean
  quotaStatus?: number
  /** When set, checkin-activity-status returns this HTTP status (no body). */
  checkinStatusStatus?: number
  /** Authoritative checkin status payload (data envelope). Default: inactive. */
  checkinStatus?: Record<string, unknown>
  /** When set, daily-checkin returns this HTTP status + JSON body. */
  checkinClaimResponse?: { status: number; body: Record<string, unknown> }
  modelsStatus?: number
  authStateStatus?: number
  refreshStatus?: number
  /** Artificial latency on the token-refresh endpoint (single-flight tests). */
  refreshDelayMs?: number
  accountNeverReady?: boolean
}

export class FakeWorkBuddyCN {
  readonly server: ReturnType<typeof createServer>
  port = 0
  behaviour: FakeBehaviour = {}
  /** Set true when a chat SSE connection is closed by the client before it ends. */
  chatClientClosed = false
  /** True when a hang-mode chat response was aborted by the consumer. */
  lastChatAborted = false
  lastChatBody?: Record<string, unknown>
  /** Authorization headers observed on chat calls (fake tokens only). */
  chatAuthorizations: string[] = []
  /** Times the token-refresh endpoint was hit (single-flight assertion). */
  refreshCalls = 0

  loginUrl = 'https://www.codebuddy.cn/login/?platform=ide&state=fake-state'

  private tokenPollCount = 0
  private accountPollCount = 0
  private tokenSerial = 0
  /** Times the claim endpoint was actually hit (0 ⇒ guard worked). */
  checkinClaimCalls = 0

  constructor() {
    this.server = createServer((req, res) => this.dispatch(req, res))
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (address && typeof address === 'object') this.port = address.port
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  endpoint(): string {
    return `http://127.0.0.1:${this.port}`
  }

  private dispatch(req: IncomingMessage, res: ServerResponse): void {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const b = this.behaviour
    const delay = b.delayMs ?? 0
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const delayed = (fn: () => void): void => {
      if (delay > 0) setTimeout(fn, delay)
      else fn()
    }

    if (path === '/v2/plugin/auth/state') {
      return delayed(() => {
        if (b.authStateStatus) return void json(b.authStateStatus, { code: 1, message: 'auth fail' })
        return void json(200, { code: 0, data: { state: `fake-state-${Date.now()}`, authUrl: this.loginUrl } })
      })
    }

    if (path === '/v2/plugin/auth/token') {
      return delayed(() => {
        if (b.tokenNeverReady) return void json(200, { code: 11217, message: 'not ready' })
        this.tokenPollCount += 1
        const readyAfter = b.tokenReadyAfterPolls ?? 0
        if (this.tokenPollCount <= readyAfter) {
          return void json(200, { code: 11217, message: 'not ready yet' })
        }
        return void json(200, { code: 0, data: this.tokenPayload() })
      })
    }

    if (path === '/v2/plugin/login/account') {
      return delayed(() => {
        if (b.accountNeverReady) return void json(200, { code: 12151, message: 'account not ready' })
        this.accountPollCount += 1
        if (this.accountPollCount <= 1) {
          return void json(200, { code: 12151, message: 'account assembling' })
        }
        return void json(200, { code: 0, data: this.accountPayload })
      })
    }

    if (path === '/v2/plugin/auth/token/refresh') {
      this.refreshCalls += 1
      const respond = (): void => {
        if (b.refreshStatus) return void json(b.refreshStatus, { code: 1, message: 'refresh fail' })
        return void json(200, { code: 0, data: this.tokenPayload() })
      }
      if (b.refreshDelayMs) {
        setTimeout(respond, b.refreshDelayMs)
        return
      }
      respond()
      return
    }

    if (path === '/console/enterprises/personal/models' || path === '/v3/config') {
      return delayed(() => {
        if (b.modelsStatus) return void json(b.modelsStatus, { code: b.modelsStatus, message: 'models fail' })
        return void json(200, {
          code: 0,
          data: {
            agents: [{ name: 'craft', models: ['deepseek-v4-flash', 'hy4-preview'] }],
            models: this.defaultModels(),
          },
        })
      })
    }

    if (path === '/v2/billing/meter/checkin-activity-status') {
      return delayed(() => {
        if (b.checkinStatusStatus) return void json(b.checkinStatusStatus, { code: 1, message: 'status fail' })
        return void json(200, { code: 0, data: b.checkinStatus ?? { active: false, today_checked_in: false } })
      })
    }

    if (path === '/v2/billing/meter/daily-checkin') {
      this.checkinClaimCalls++
      return delayed(() => {
        const r = b.checkinClaimResponse ?? { status: 200, body: { code: 0, data: { credit: 5 } } }
        json(r.status, r.body)
      })
    }

    if (path === '/v2/billing/meter/get-user-resource') {
      return delayed(() => {
        if (b.quotaStatus) return void json(b.quotaStatus, { code: 1, message: 'quota fail' })
        return void json(200, {
          code: 0,
          data: { Response: { Data: { Accounts: [this.quotaPackage()] } } },
        })
      })
    }

    if (path === '/v2/chat/completions') {
      if (typeof req.headers.authorization === 'string') {
        this.chatAuthorizations.push(req.headers.authorization)
      }
      void readJson(req).then((body) => {
        this.lastChatBody = body
        this.handleChat(res, b)
      })
      return
    }

    json(404, { code: 404, message: `no route ${path}` })
  }

  private handleChat(res: ServerResponse, b: FakeBehaviour): void {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (b.malformedChat) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('this is not json\n')
      return
    }
    if (b.chatStatus) {
      return void json(b.chatStatus, { code: b.chatStatus, message: 'chat blocked' })
    }
    if (b.chatScript) {
      const script = b.chatScript()
      if (script.kind !== 'stream') return void json(script.status, script.body)
      this.writeSse(res, script.frames)
      return
    }
    const frames = [
      'data: {"choices":[{"delta":{"reasoning_content":"thinking..."},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":" World"},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]
    this.writeSse(res, frames)
  }

  private writeSse(res: ServerResponse, frames: string[]): void {
    if (this.behaviour.chatHangSecs) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      // Hang: write only non-terminal deltas (drop [DONE] and any finish_reason),
      // then hold the connection open so the consumer must rely on its own timeout.
      const deltas = frames.filter((f) =>
        f.trim() !== 'data: [DONE]' && !f.includes('"finish_reason":"stop"') && !f.includes('"finish_reason":"length"'),
      )
      if (deltas.length > 0) res.write(deltas.join('\n') + '\n\n')
      // Record a client-side teardown of the still-open stream so tests can
      // prove the extension truly released its upstream connection.
      res.on('close', () => { this.lastChatAborted = true; this.chatClientClosed = true })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.end(frames.join('\n') + '\n\n')
  }

  quotaPackage(): Record<string, unknown> {
    return {
      PackageName: 'Free Plan',
      CapacityUnit: 'credits',
      Status: 0,
      CycleCapacityRemain: 1000,
      CycleCapacityRemainPrecise: '1000.00',
      CycleCapacitySize: 5000,
      CycleCapacityUsed: 4000,
      ExpiredTime: '',
      DeductionEndTime: 0,
    }
  }

  defaultModels(): Array<Record<string, unknown>> {
    return [
      { id: 'deepseek-v4-flash', name: 'Deepseek V4 Flash', maxInputTokens: 1_000_000, maxOutputTokens: 50_000, supportsImages: true, reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high' } },
      { id: 'hy4-preview', name: 'Hy4 Preview', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, reasoning: { supportedEfforts: ['high'], defaultEffort: 'high' } },
    ]
  }

  tokenPayload(): Record<string, unknown> {
    this.tokenSerial += 1
    const serial = `${this.tokenSerial}-${Date.now()}`
    return {
      accessToken: `fake-access-${serial}`,
      refreshToken: `fake-refresh-${serial}`,
      expiresIn: 8000,
      refreshExpiresIn: 86400,
      tokenType: 'Bearer',
      scope: 'profile offline_access',
      domain: '',
    }
  }

  accountPayload: Record<string, unknown> = {
    uid: 'fake-upstream-uid-123',
    nickname: 'FakeUser',
    enterpriseId: '',
    type: 'personal',
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}