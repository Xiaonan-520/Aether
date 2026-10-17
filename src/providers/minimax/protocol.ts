/**
 * MiniMax Code (China + International) protocol layer.
 *
 * Upstream speaks the **Anthropic Messages** protocol, not OpenAI chat:
 *
 *   POST {apiHost}/mavis/api/v1/llm/v1/messages
 *   Authorization: Bearer <access_token>
 *
 * This module is pure (no network) so the wire shapes can be locked by tests.
 * The extension translates OpenAI-compatible requests into this shape and folds
 * the Anthropic SSE stream back into the gateway's canonical ChatChunk.
 *
 * Key protocol facts (each verified against the reference implementation
 * iJetLi/dsh-providers-hub, src/minimax-*.ts):
 *
 *   - `system` is a TOP-LEVEL field, never a `{role:'system'}` message.
 *   - assistant text/tool-calls → `content` blocks (`text` / `tool_use`).
 *   - tool results → `tool_result` blocks inside a `user` message, and they must
 *     immediately follow the assistant turn that produced them.
 *   - SSE events: message_start / content_block_start / content_block_delta /
 *     content_block_stop / message_delta / message_stop / ping / error.
 *   - `thinking_delta` → reasoning; `signature_delta` MUST be ignored (it is a
 *     signature, not text); `input_json_delta` → tool argument fragments.
 *   - Do NOT send `thinking.type='disabled'`: M3.1 rejects it with a hard 400.
 *     Omitting `thinking` is the safe default.
 */

export interface MinimaxProduct {
  id: string
  displayName: string
  accountHost: string
  apiHost: string
  region: 'cn' | 'en'
  clientId: string
  scope: string
  audience: string
  inferPath: string
  modelsPath: string
  fallbackModels: ReadonlyArray<{ id: string; name: string }>
}

export const MINIMAX_INFER_PATH = '/mavis/api/v1/llm/v1/messages'

export const MINIMAX: MinimaxProduct = {
  id: 'minimax',
  displayName: 'MiniMax Code (中国版)',
  accountHost: 'https://account.minimax.cn',
  apiHost: 'https://agent.minimax.cn',
  region: 'cn',
  clientId: 'mcode-public',
  scope: 'agent.default',
  audience: 'agent-backend',
  inferPath: MINIMAX_INFER_PATH,
  modelsPath: '/mavis/api/v1/models',
  fallbackModels: [
    { id: 'MiniMax-M3.1-Flash-Preview', name: 'M3.1-Flash-Preview' },
    { id: 'MiniMax-M3', name: 'M3' },
    { id: 'MiniMax-M2.7-highspeed', name: 'M2.7-highspeed' },
    { id: 'MiniMax-M2.7', name: 'M2.7' },
  ],
}

export const MINIMAX_INTL: MinimaxProduct = {
  id: 'minimaxintl',
  displayName: 'MiniMax Code (国际版)',
  accountHost: 'https://account.minimax.io',
  apiHost: 'https://agent.minimax.io',
  region: 'en',
  clientId: 'mcode-public',
  scope: 'agent.default',
  audience: 'agent-backend',
  inferPath: MINIMAX_INFER_PATH,
  modelsPath: '/mavis/api/v1/models',
  fallbackModels: MINIMAX.fallbackModels,
}

export const MINIMAX_DEVICE_CODE_PATH = '/oauth2/device/code'
export const MINIMAX_TOKEN_PATH = '/oauth2/token'

// ---------------------------------------------------------------------------
// OAuth device code (RFC 8628 + PKCE S256)
// ---------------------------------------------------------------------------

export interface MinimaxDeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresInMs: number
  intervalMs: number
  codeVerifier: string
}

export interface MinimaxCredential {
  access_token: string
  refresh_token?: string
  /** epoch ms */
  expires_at?: number
  display_name?: string
  region?: string
}

export function credentialExpiresAtMs(credential: MinimaxCredential): number | undefined {
  return typeof credential.expires_at === 'number' ? credential.expires_at : undefined
}

export function isExpired(credential: MinimaxCredential, now = Date.now()): boolean {
  const at = credentialExpiresAtMs(credential)
  return at !== undefined && now >= at - 30_000
}

export function isRefreshable(credential: MinimaxCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
}

/** Token endpoint body for a refresh (client_id + scope + audience are required). */
export function buildRefreshBody(refreshToken: string, product: MinimaxProduct): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: product.clientId,
    scope: product.scope,
    audience: product.audience,
  })
}

export function buildPollBody(auth: MinimaxDeviceAuthorization, product: MinimaxProduct): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: auth.deviceCode,
    client_id: product.clientId,
    code_verifier: auth.codeVerifier,
  })
}

// ---------------------------------------------------------------------------
// Chat request: OpenAI-compatible → Anthropic Messages
// ---------------------------------------------------------------------------

export type OpenAiMessage = {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
  name?: string
}

export interface MinimaxPayloadOptions {
  model: string
  messages: OpenAiMessage[]
  maxTokens?: number
  temperature?: number
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>
  thinking?: { type: 'adaptive' } | undefined
}

export interface MinimaxContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  [key: string]: unknown
}

export interface MinimaxWireMessage {
  role: 'user' | 'assistant'
  content: MinimaxContentBlock[]
}

function textOf(content: OpenAiMessage['content']): string {
  if (typeof content === 'string') return content
  return ''
}

/**
 * Build the Anthropic-shaped payload.
 *
 * `system` messages are hoisted into the top-level `system` field (the endpoint
 * rejects a `role:'system'` message). Multiple system/developer messages are
 * concatenated in order — nothing is dropped.
 *
 * Orphan tool results and tool calls whose result is missing are removed: the
 * endpoint 400s on either, and keeping them would break the whole turn.
 */
export function buildMinimaxPayload(opts: MinimaxPayloadOptions): Record<string, unknown> {
  const systemParts: string[] = []
  for (const m of opts.messages) {
    if (m.role === 'system' || m.role === 'developer') {
      const t = textOf(m.content)
      if (t !== '') systemParts.push(t)
    }
  }

  // Which tool_call ids actually have a result?
  const resultIds = new Set<string>()
  for (const m of opts.messages) {
    if (m.role === 'tool' && typeof m.tool_call_id === 'string' && m.tool_call_id) {
      resultIds.add(m.tool_call_id)
    }
  }
  // Keep only calls that have a result (avoids an orphan tool_use → 400).
  const keepCallIds = new Set<string>()
  for (const m of opts.messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    for (const tc of m.tool_calls) {
      const id = tc.id
      if (typeof id !== 'string' || id === '') continue
      if (!tc.function?.name) continue
      if (resultIds.has(id)) keepCallIds.add(id)
    }
  }

  const wire: MinimaxWireMessage[] = []
  for (const m of opts.messages) {
    if (m.role === 'system' || m.role === 'developer') continue

    if (m.role === 'tool') {
      const id = m.tool_call_id
      if (typeof id !== 'string' || !keepCallIds.has(id)) continue // orphan → drop
      const block: MinimaxContentBlock = {
        type: 'tool_result',
        tool_use_id: id,
        content: textOf(m.content),
      }
      // Anthropic requires tool_result blocks inside a user message, immediately
      // after the assistant turn that produced them.
      wire.push({ role: 'user', content: [block] })
      continue
    }

    if (m.role === 'assistant') {
      const blocks: MinimaxContentBlock[] = []
      const text = textOf(m.content)
      if (text !== '') blocks.push({ type: 'text', text })
      for (const tc of m.tool_calls ?? []) {
        const id = tc.id
        if (typeof id !== 'string' || !keepCallIds.has(id)) continue
        let input: unknown = {}
        try {
          input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          input = {} // never fabricate parameters
        }
        blocks.push({ type: 'tool_use', id, name: tc.function?.name ?? '', input })
      }
      if (blocks.length === 0) continue // nothing to say
      wire.push({ role: 'assistant', content: blocks })
      continue
    }

    // user
    const text = textOf(m.content)
    if (text === '') continue
    wire.push({ role: 'user', content: [{ type: 'text', text }] })
  }

  const payload: Record<string, unknown> = {
    model: opts.model,
    messages: wire,
    stream: true,
    max_tokens: opts.maxTokens ?? 8192,
  }
  if (systemParts.length > 0) payload.system = systemParts.join('\n\n')
  if (typeof opts.temperature === 'number') payload.temperature = opts.temperature
  if (opts.tools && opts.tools.length > 0) {
    payload.tools = opts.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }))
  }
  // Deliberately NO `thinking` field by default: `disabled` is a hard 400 on
  // M3.1, and omitting it is accepted everywhere (the model may think anyway).
  if (opts.thinking) payload.thinking = opts.thinking
  return payload
}

// ---------------------------------------------------------------------------
// SSE: Anthropic events → canonical chunks
// ---------------------------------------------------------------------------

export interface MinimaxChunk {
  text: string
  reasoning?: string
  finishReason?: 'stop' | 'length' | 'tool_calls' | null
  usage?: { promptTokens?: number; completionTokens?: number }
  toolCalls?: Array<{ id?: string; name?: string; arguments?: string; index?: number }>
}

export function mapStopReason(reason: unknown): 'stop' | 'length' | 'tool_calls' {
  if (reason === 'max_tokens') return 'length'
  if (reason === 'tool_use') return 'tool_calls'
  return 'stop'
}

/** Parse one Anthropic SSE `data:` payload into zero or more canonical chunks. */
export function parseMinimaxEvent(raw: string): MinimaxChunk[] {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return []
  }
  const type = data.type

  if (type === 'ping') return []

  if (type === 'error') {
    const err = data.error as { type?: string; message?: string } | undefined
    const message = err?.message ?? 'upstream error frame'
    const kind = typeof err?.type === 'string' && /rate/i.test(err.type) ? 'RATE_LIMIT' : 'UPSTREAM_5XX'
    const e = new Error(message) as Error & { upKind?: string }
    e.upKind = kind
    throw e
  }

  if (type === 'message_start') {
    const msg = data.message as Record<string, unknown> | undefined
    const usage = msg?.usage as Record<string, unknown> | undefined
    const prompt = typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined
    if (prompt === undefined) return []
    return [{ text: '', usage: { promptTokens: prompt } }]
  }

  if (type === 'content_block_start') {
    const block = data.content_block as Record<string, unknown> | undefined
    if (block?.type === 'tool_use') {
      return [{
        text: '',
        toolCalls: [{
          id: typeof block.id === 'string' ? block.id : undefined,
          name: typeof block.name === 'string' ? block.name : undefined,
          arguments: '',
          index: typeof data.index === 'number' ? data.index : 0,
        }],
      }]
    }
    return []
  }

  if (type === 'content_block_delta') {
    const delta = data.delta as Record<string, unknown> | undefined
    if (!delta) return []
    const dt = delta.type
    if (dt === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
      return [{ text: delta.text }]
    }
    if (dt === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
      return [{ text: '', reasoning: delta.thinking }]
    }
    if (dt === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json.length > 0) {
      return [{
        text: '',
        toolCalls: [{
          arguments: delta.partial_json,
          index: typeof data.index === 'number' ? data.index : 0,
        }],
      }]
    }
    // signature_delta: a thinking signature, NOT text. Ignore it.
    return []
  }

  if (type === 'message_delta') {
    const delta = data.delta as Record<string, unknown> | undefined
    const usage = data.usage as Record<string, unknown> | undefined
    const out: MinimaxChunk = { text: '' }
    if (delta && typeof delta.stop_reason === 'string') {
      out.finishReason = mapStopReason(delta.stop_reason)
    } else {
      out.finishReason = null
    }
    if (usage && typeof usage.output_tokens === 'number') {
      out.usage = { completionTokens: usage.output_tokens }
    }
    return [out]
  }

  return []
}
