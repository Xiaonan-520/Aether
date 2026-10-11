/**
 * Chat + streaming against the WorkBuddyCN upstream, normalized to the Phase 3
 * protocol chat shapes (ChatChunk / ChatResult).
 *
 * The extension NEVER chooses an account: Core supplies `accountId` on every
 * request. `requestId` and `deadlineMs` come from Core and bound the exchange.
 */
import type { Credential, Store } from '../../storage/store.js'
import type { UpstreamClient } from './client.js'
import { errors, ProtocolError } from '../../protocol/errors.js'
import type { ChatChunk, ChatResult, ExtensionChatRequest } from '../../protocol/types.js'
import { credentialExpiresAtMs, isExpired } from './parsing.js'
import { refreshCredential, RefreshTokenExpiredError } from './auth.js'

export interface ChatDeps {
  client: UpstreamClient
  store: Store
  resolveCredential: (accountId: string) => Credential | undefined
  ensureFresh: (accountId: string, credential: Credential) => Promise<Credential>
  timeoutMs: number
  firstTokenTimeoutMs: number
  chunkIdleTimeoutMs: number
}

const isDeepSeek = (model: string): boolean => /^deepseek/i.test(model.trim())

/** Max output tokens per model line (fallback when upstream discovery is unavailable). */
const MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> = {
  'deepseek-v4-flash': 50_000,
  'deepseek-v4-pro': 128_000,
  'deepseek-v4.1-flash': 128_000,
  'hy4-preview': 64_000,
  'hy4-preview-x': 64_000,
  'hy4-preview-f': 64_000,
  hy3: 64_000,
  'hy3-x': 64_000,
  'glm-5.3': 64_000,
  'glm-5.3-flash': 32_000,
  'glm-5.2': 64_000,
  'glm-5.1': 48_000,
  'glm-5v-turbo': 64_000,
  'kimi-k3-1': 32_000,
  'kimi-k2.7': 32_000,
  'kimi-k2.6': 32_000,
  'minimax-m3': 64_000,
}

function serializeMessages(messages: ExtensionChatRequest['messages']): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  for (const message of messages) {
    const role = message.role
    if (role === 'assistant') {
      const content = message.content
      const text = contentToText(content)
      const toolCalls = message.tool_calls
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: toolCalls && text === '' ? null : text,
      }
      // Reasoning models require the field to be present (upstream 400 otherwise).
      entry.reasoning_content = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
      if (toolCalls) entry.tool_calls = toolCalls
      wire.push(entry)
    } else if (role === 'tool') {
      wire.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content })
    } else {
      wire.push({ role, content: message.content })
    }
  }
  return wire
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text?: unknown } => Boolean(b) && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('')
}

function buildBody(req: ExtensionChatRequest): string {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: serializeMessages(req.messages),
    stream: true,
  }
  if (req.requestId) body.prompt_cache_key = req.requestId
  if (req.tools && req.tools.length > 0) body.tools = req.tools.map(normalizeTool)
  if (req.temperature !== undefined) body.temperature = req.temperature
  const maxTokens = req.maxTokens ?? MAX_OUTPUT_TOKENS[req.model]
  if (maxTokens !== undefined) body.max_tokens = maxTokens

  // DeepSeek thought toggle: reasoning_effort is the real switch; `thinking`
  // accompanies it. Non-DeepSeek models only get reasoning_effort.
  if (isDeepSeek(req.model)) {
    body.thinking = { type: 'enabled' }
    if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort
  } else if (req.reasoningEffort) {
    body.reasoning_effort = req.reasoningEffort
  }
  return JSON.stringify(body)
}

function normalizeTool(tool: unknown): unknown {
  const record = tool as Record<string, unknown>
  if (record && typeof record === 'object' && 'function' in record) return tool
  return { type: 'function', function: { name: record?.name, description: record?.description, parameters: record?.parameters } }
}

/** Map an upstream non-OK response to a ProtocolError (business codes first). */
function upstreamError(status: number, bodyText: string): ProtocolError {
  const parsed = safeJson(bodyText)
  const code = parsed && typeof parsed.code === 'number' ? parsed.code : undefined
  const msg = parsed && typeof parsed.msg === 'string' ? parsed.msg
    : parsed && typeof parsed.message === 'string' ? parsed.message
      : ''
  if (code === 6004 || /频率限制|频率超出|使用量已超出|rate.?limit|frequency limit|usage exceeds|too many requests/i.test(msg)) {
    return errors.rateLimit('upstream rate limit', { httpStatus: 429, retryable: true })
  }
  if (status === 401 || status === 403) return errors.authInvalid(`upstream auth rejected (HTTP ${status})`, { httpStatus: status })
  if (status === 429) return errors.rateLimit('upstream rate limit', { httpStatus: 429, retryable: true })
  if (status >= 500) return errors.upstream5xx(`upstream HTTP ${status}`, { httpStatus: status })
  if (status === 400) return errors.terminal('invalid chat request rejected by upstream', { httpStatus: 400 })
  return errors.terminal(`upstream HTTP ${status}`, { httpStatus: status })
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

interface PreparedRequest {
  response: Response
}

/** Resolve the account credential, refresh if needed, and open the upstream stream. */
async function openUpstream(req: ExtensionChatRequest, deps: ChatDeps, signal?: AbortSignal): Promise<PreparedRequest> {
  const credential = deps.resolveCredential(req.accountId)
  if (!credential) throw errors.authInvalid(`unknown account ${req.accountId}`, { httpStatus: 404 })
  const fresh = await deps.ensureFresh(req.accountId, credential)
  const body = buildBody(req)
  let response: Response
  try {
    response = await deps.client.chat(fresh, body, signal)
  } catch (error) {
    throw error
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw upstreamError(response.status, text)
  }
  if (!response.body) throw errors.emptyResponse('upstream returned an empty body')
  return { response }
}

/** Non-streaming chat: consume the upstream SSE and aggregate to ChatResult. */
export async function chatNonStreaming(
  req: ExtensionChatRequest,
  deps: ChatDeps,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const { response } = await openUpstream(req, deps, signal)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  let finishReason = 'stop'
  const toolOrder: number[] = []
  const toolMap = new Map<number, { id?: string; name?: string; arguments: string }>()
  let usage: { promptTokens?: number; completionTokens?: number } | undefined
  let streamEnded = false

  try {
    for (;;) {
      if (streamEnded) break
      const chunk = await readWithIdleTimeout(reader, deps.chunkIdleTimeoutMs, signal)
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline = -1
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') { streamEnded = true; break }
        const frame = parseUpstreamFrame(payload)
        if (!frame) continue
        if (frame.content) content += frame.content
        if (frame.reasoning) reasoning += frame.reasoning
        if (frame.finishReason) finishReason = frame.finishReason
        if (frame.usage) usage = frame.usage
        if (frame.toolCalls) {
          for (const call of frame.toolCalls) {
            if (!toolMap.has(call.index)) { toolMap.set(call.index, { id: call.id, name: call.name, arguments: '' }); toolOrder.push(call.index) }
            const entry = toolMap.get(call.index)!
            if (call.id) entry.id = call.id
            if (call.name) entry.name = call.name
            if (call.arguments) entry.arguments += call.arguments
          }
        }
      }
    }
  } finally {
    if (!streamEnded) await reader.cancel().catch(() => undefined)
  }

  const result: ChatResult = { content, finishReason }
  if (reasoning.length > 0) result.reasoning = reasoning
  if (usage) result.usage = usage
  return result
}

/**
 * Streaming chat: yield protocol ChatChunk objects. Exactly one terminal signal
 * is emitted by the caller: the generator yields a chunk with `finishReason` on
 * success, or throws a ProtocolError on failure.
 */
export async function* chatStream(
  req: ExtensionChatRequest,
  deps: ChatDeps,
  signal?: AbortSignal,
): AsyncIterable<ChatChunk> {
  const { response } = await openUpstream(req, deps, signal)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let streamEnded = false
  let firstToken = false
  const toolIds = new Map<number, string>()
  let emittedAny = false

  try {
    for (;;) {
      if (streamEnded) break
      const timeoutMs = firstToken ? deps.chunkIdleTimeoutMs : deps.firstTokenTimeoutMs
      const chunk = await readWithIdleTimeout(reader, timeoutMs, signal)
      if (chunk.done) break
      firstToken = true
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline = -1
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') { streamEnded = true; break }
        const frame = parseUpstreamFrame(payload)
        if (!frame) continue
        if (frame.content !== undefined) {
          emittedAny = true
          yield { text: frame.content }
        }
        if (frame.reasoning !== undefined) {
          emittedAny = true
          yield { text: '', reasoning: frame.reasoning }
        }
        if (frame.toolCalls) {
          const calls = frame.toolCalls.map((c) => {
            if (c.id) toolIds.set(c.index, c.id)
            return { id: toolIds.get(c.index), name: c.name, arguments: c.arguments }
          })
          emittedAny = true
          yield { text: '', toolCalls: calls }
        }
        if (frame.finishReason) {
          yield { text: '', finishReason: frame.finishReason, ...(frame.usage ? { usage: frame.usage } : {}) }
          streamEnded = true
          break
        }
      }
    }
    if (!streamEnded && !emittedAny) {
      // Upstream closed with no frames: surface as empty response, not a silent hang.
      throw errors.emptyResponse('upstream stream ended with no content')
    }
    if (!streamEnded) {
      yield { text: '', finishReason: 'stop' }
    }
  } finally {
    if (!streamEnded) await reader.cancel().catch(() => undefined)
  }
}

interface UpstreamFrame {
  content?: string
  reasoning?: string
  finishReason?: 'stop' | 'length' | 'tool_calls'
  usage?: { promptTokens?: number; completionTokens?: number }
  toolCalls?: Array<{ index: number; id?: string; name?: string; arguments?: string }>
}

function parseUpstreamFrame(payload: string): UpstreamFrame | null {
  const data = safeJson(payload)
  if (!data) return null
  if (data.error && typeof data.error === 'object') {
    const message = (data.error as { message?: unknown }).message
    throw errors.upstream5xx(typeof message === 'string' ? message : 'upstream error frame')
  }
  const choices = Array.isArray(data.choices) ? data.choices : []
  const choice = choices[0] as Record<string, unknown> | undefined
  if (!choice) return null
  const delta = choice.delta as Record<string, unknown> | undefined
  const frame: UpstreamFrame = {}
  if (typeof choice.finish_reason === 'string') frame.finishReason = choice.finish_reason as UpstreamFrame['finishReason']
  if (delta) {
    if (typeof delta.content === 'string') frame.content = delta.content
    if (typeof delta.reasoning_content === 'string') frame.reasoning = delta.reasoning_content
    if (Array.isArray(delta.tool_calls)) {
      frame.toolCalls = (delta.tool_calls as Array<Record<string, unknown>>).map((call) => {
        const fn = call.function as Record<string, unknown> | undefined
        return {
          index: typeof call.index === 'number' ? call.index : 0,
          id: typeof call.id === 'string' ? call.id : undefined,
          name: typeof fn?.name === 'string' && fn.name.length > 0 ? fn.name : undefined,
          arguments: typeof fn?.arguments === 'string' ? fn.arguments : undefined,
        }
      })
    }
  }
  const usage = data.usage as Record<string, unknown> | undefined
  if (usage) {
    frame.usage = {
      promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
      completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    }
  }
  if (frame.content === undefined && frame.reasoning === undefined && frame.toolCalls === undefined
    && frame.finishReason === undefined && frame.usage === undefined) return null
  return frame
}

/**
 * Read a chunk from the SSE reader guarded by an idle timeout, honoring an
 * external AbortSignal. On timeout/abort the upstream reader is cancelled so the
 * connection is truly released.
 */
export async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal?.aborted) throw errors.transport('request cancelled')
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanup = (): void => {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  const onAbort = (): void => cleanup()
  signal?.addEventListener('abort', onAbort, { once: true })

  // The timeout promise rejects ONLY; cancelling the reader happens in the catch
  // below. Cancelling inside the timer would let the pending read() resolve
  // {done:true} and win the race, masking the timeout.
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(errors.timeout(`upstream idle timeout after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    const result = await Promise.race([reader.read(), timeoutPromise])
    return result as { done: boolean; value?: Uint8Array }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (signal?.aborted) throw errors.transport('request cancelled')
    if (error instanceof ProtocolError) throw error
    throw errors.transport('upstream stream read failed')
  } finally {
    cleanup()
  }
}

export { isExpired, credentialExpiresAtMs, refreshCredential, RefreshTokenExpiredError }
