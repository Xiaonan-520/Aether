/**
 * Fake ZCode upstream —— 可编程 HTTP 服务器，模拟 zcode.z.ai 端点：
 * oauth cli init/poll、anthropic messages（JSON/SSE）、billing/balance、
 * client/configs（captcha 配置）、以及故障注入（401/429/500/3007 挑战/挂起）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface FakeBehaviour {
  /** init 返回此状态（默认 200） */
  authStateStatus?: number
  /** poll 永不 ready */
  tokenNeverReady?: boolean
  /** 第 N 次 poll 后 ready */
  tokenReadyAfterPolls?: number
  /** refresh...（zcode 无刷新端点；预留） */
  chatStatus?: number
  /** chat 脚本覆盖 */
  chatScript?: () => { kind: 'stream'; frames: string[] } | { kind: 'json'; status: number; body: Record<string, unknown> }
  /** chat 挂起（写头不写体） */
  chatHangSecs?: number
  /** 上游 403 + captcha 挑战头 */
  chatChallengeHeader?: boolean
  /** 上游 400 + {"code":3007} 体挑战 */
  chatChallengeBody?: boolean
  /** billing HTTP 状态 */
  quotaStatus?: number
  /** billing 载荷（data 信封） */
  quotaPayload?: Record<string, unknown>
  /** configs 端点状态 */
  configsStatus?: number
}

interface JwtParts {
  jwt: string
  access: string
  nickname: string
}

export class FakeZCode {
  readonly server: ReturnType<typeof createServer>
  port = 0
  behaviour: FakeBehaviour = {}
  /** 观测到的 chat Authorization 头（fake 令牌） */
  chatAuthorizations: string[] = []
  /** chat 请求体（anthropic 形态） */
  lastChatBody?: Record<string, unknown>
  /** poll 调用次数（单飞断言） */
  pollCalls = 0
  /** init 调用次数 */
  initCalls = 0
  /** chat 是否被客户端提前断开 */
  chatClientClosed = false

  private tokenPollCount = 0
  private tokenSerial = 0

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
  }

  endpoint(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  mint(): JwtParts {
    this.tokenSerial += 1
    const n = this.tokenSerial
    return {
      jwt: `fake-jwt-${n}`,
      access: `fake-access-${n}`,
      nickname: `Fake User ${n}`,
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    try {
      if (req.method === 'POST' && url === '/api/v1/oauth/cli/init') {
        this.initCalls += 1
        if (this.behaviour.authStateStatus && this.behaviour.authStateStatus !== 200) {
          res.writeHead(this.behaviour.authStateStatus, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: 1, msg: 'init rejected' }))
          return
        }
        const token = this.mint()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          code: 200,
          data: {
            flow_id: `flow-${token.jwt}`,
            authorize_url: `https://chat.z.ai/app/oauth/login?redirect=https%3A%2F%2Fzcode.z.ai%2Fauth&state=fake-${token.jwt}`,
            poll_interval_sec: 1,
          },
        }))
        return
      }

      const pollMatch = /^\/api\/v1\/oauth\/cli\/poll\/(.+)$/.exec(url)
      if (req.method === 'GET' && pollMatch) {
        this.pollCalls += 1
        if (this.behaviour.tokenNeverReady) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: 200, data: { status: 'pending' } }))
          return
        }
        const readyAfter = this.behaviour.tokenReadyAfterPolls ?? 1
        if (this.tokenPollCount >= readyAfter) {
          const token = this.mint()
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            code: 200,
            data: { status: 'ready', token: token.jwt, access_token: token.access, nickname: token.nickname },
          }))
        } else {
          this.tokenPollCount += 1
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: 200, data: { status: 'pending' } }))
        }
        return
      }

      if (req.method === 'POST' && url === '/api/v1/zcode-plan/anthropic/v1/messages') {
        await this.handleChat(req, res)
        return
      }

      if (req.method === 'GET' && (url === '/api/v1/zcode-plan/billing/current' || url === '/api/v1/zcode-plan/billing/balance')) {
        const status = this.behaviour.quotaStatus ?? 200
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: status }))
          return
        }
        const data = this.behaviour.quotaPayload ?? {
          remaining: 42, total: 100, resetAt: Date.now() + 86_400_000,
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 200, data }))
        return
      }

      if (req.method === 'GET' && url === '/api/v1/client/configs') {
        const status = this.behaviour.configsStatus ?? 200
        if (status !== 200) {
          res.writeHead(status)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          code: 200,
          data: { configs: { captcha: { enabled: true, prefix: 'no8xfe', region: 'sgp', sceneId: '11xygtvd' } } },
        }))
        return
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `no fake route: ${req.method} ${url}` }))
    } catch (err) {
      try {
        res.writeHead(500)
        res.end(String(err))
      } catch {
        /* ignore */
      }
    }
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authHeader = req.headers.authorization ?? ''
    this.chatAuthorizations.push(authHeader)
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    try {
      this.lastChatBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    } catch {
      this.lastChatBody = undefined
    }

    if (this.behaviour.chatChallengeHeader) {
      // 挑战只命中一次：真实上游对一个被拒令牌通常返回一次挑战，
      // 随后的合法重试会被放行（这里模拟该语义）
      this.behaviour.chatChallengeHeader = false
      res.writeHead(403, {
        'content-type': 'application/json',
        'x-aliyun-captcha-verify-param': 'challenge-issued',
      })
      res.end(JSON.stringify({ error: { message: 'captcha challenge' } }))
      return
    }
    if (this.behaviour.chatChallengeBody) {
      this.behaviour.chatChallengeBody = false
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 3007, msg: 'captcha verify required' }))
      return
    }
    if (this.behaviour.chatStatus && this.behaviour.chatStatus !== 200) {
      res.writeHead(this.behaviour.chatStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `fake upstream ${this.behaviour.chatStatus}` } }))
      return
    }
    if (this.behaviour.chatHangSecs) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      req.on('close', () => {
        this.chatClientClosed = true
      })
      await new Promise((resolve) => setTimeout(resolve, this.behaviour.chatHangSecs * 1000))
      try { res.end() } catch { /* ignore */ }
      return
    }

    const scripted = this.behaviour.chatScript?.()
    if (scripted) {
      if (scripted.kind === 'json') {
        res.writeHead(scripted.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(scripted.body))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of scripted.frames) {
        res.write(frame)
        await new Promise((r) => setTimeout(r, 5))
      }
      res.end()
      return
    }

    const wantsStream = this.lastChatBody?.stream === true
    if (!wantsStream) {
      // 非流式：anthropic messages JSON
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 2 },
      }))
      return
    }
    // 流式：SSE 三帧（anthropic 形态）
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const frames = [
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })}\n\n`,
    ]
    for (const frame of frames) {
      res.write(frame)
      await new Promise((r) => setTimeout(r, 5))
    }
    res.end()
  }
}
