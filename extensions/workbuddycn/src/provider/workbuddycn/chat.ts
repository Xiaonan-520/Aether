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
import { normalizeChannelText } from '../../util/channel-text.js'

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

export function serializeMessages(messages: ExtensionChatRequest['messages']): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  const emittedToolCallIds = new Set<string>()
  for (const message of messages) {
    const role = message.role
    if (role === 'assistant') {
      const content = message.content
      // Assistant text is part of the upstream channel check (confirmed: the
      // same git-context label that fails in `system` also fails here), and a
      // transcript replays it on every later turn. Normalize before mapping.
      const text = normalizeChannelText(contentToText(content))
      // Core sends canonical camelCase (toolCalls); older OpenAI-style
      // snake_case is accepted as a fallback for direct callers.
      const toolCalls = (message as { toolCalls?: unknown; tool_calls?: unknown }).toolCalls
        ?? (message as { tool_calls?: unknown }).tool_calls
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: toolCalls && text === '' ? null : text,
      }
      // Reasoning models require the field to be present (upstream 400 otherwise).
      entry.reasoning_content = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
      if (toolCalls) {
        const calls = toOpenAiToolCalls(toolCalls)
        if (calls.length > 0) {
          entry.tool_calls = calls
          for (const call of calls) if (call.id) emittedToolCallIds.add(call.id)
        }
      }
      wire.push(entry)
    } else if (role === 'tool') {
      // Core sends canonical camelCase (toolCallId); snake_case as fallback.
      const toolCallId = (message as { toolCallId?: unknown }).toolCallId
        ?? (message as { tool_call_id?: unknown }).tool_call_id
      // Orphan tool results (no matching preceding assistant tool_calls, or no
      // id at all) make strict upstreams answer 400. Downgrade them to a user
      // note so multi-turn tool flows survive instead of hard-failing.
      if (typeof toolCallId !== 'string' || toolCallId.length === 0 || !emittedToolCallIds.has(toolCallId)) {
        const text = contentToText(message.content)
        wire.push({
          role: 'user',
          content: `[tool result${toolCallId ? ` for ${toolCallId}` : ''}] ${text}`.slice(0, 4000),
        })
      } else {
        wire.push({ role: 'tool', tool_call_id: toolCallId, content: message.content })
      }
    } else {
      // `system` is the primary surface for the channel check. Rewrite only the
      // confirmed git-context label; every other byte is preserved.
      const outContent = role === 'system' && typeof message.content === 'string'
        ? normalizeChannelText(message.content)
        : message.content
      wire.push({ role, content: outContent })
    }
  }
  return wire
}

/** Normalize canonical ToolCall[] / OpenAI tool_calls[] into upstream wire form. */
function toOpenAiToolCalls(raw: unknown): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    // Canonical shape: { id, name, arguments } (arguments may be object or string).
    if (typeof record.name === 'string' && !('function' in record)) {
      out.push({
        id: typeof record.id === 'string' && record.id ? record.id : `call_${out.length}`,
        type: 'function',
        function: {
          name: record.name,
          arguments: typeof record.arguments === 'string' ? record.arguments : JSON.stringify(record.arguments ?? {}),
        },
      })
      continue
    }
    // Already OpenAI-shaped: { type:'function', function:{name,arguments} }.
    const fn = record.function as Record<string, unknown> | undefined
    if (fn && typeof fn.name === 'string') {
      out.push({
        id: typeof record.id === 'string' && record.id ? record.id : `call_${out.length}`,
        type: 'function',
        function: { name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) },
      })
    }
  }
  return out
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
export function upstreamError(status: number, bodyText: string): ProtocolError {
  const parsed = safeJson(bodyText)
  const code = parsed && typeof parsed.code === 'number' ? parsed.code : undefined
  const msg = parsed && typeof parsed.msg === 'string' ? parsed.msg
    : parsed && typeof parsed.message === 'string' ? parsed.message
      : ''
  // Frequency/rate limiting is account-recoverable after a cooldown, while an
  // exhausted balance is not: keep them in different protocol kinds so Core
  // parks the account instead of retrying it every minute. Code 6004 is the
  // observed rate-limit code; usage/quota wording is intentionally a separate
  // branch (and checked before the HTTP status, so a 403 quota response is not
  // mistaken for a dead credential).
  if (code === 6004 || /频率限制|频率超出|rate.?limit|frequency limit|too many requests/i.test(msg)) {
    return errors.rateLimit('upstream rate limit', { httpStatus: 429, retryable: true })
  }
  if (/使用量已超出|usage exceeds|insufficient.?quota|quota.?exceed|额度.{0,8}(超出|用尽|不足)|balance insufficient/i.test(msg)) {
    return errors.quotaExhausted('upstream quota exhausted', { httpStatus: status === 429 ? 429 : status })
  }
  if (status === 401 || status === 403) return errors.authInvalid(`upstream auth rejected (HTTP ${status})`, { httpStatus: status })
  if (status === 429) return errors.rateLimit('upstream rate limit', { httpStatus: 429, retryable: true })
  if (status >= 500) return errors.upstream5xx(`upstream HTTP ${status}`, { httpStatus: status })
  if (status === 400) {
    // Diagnostic (1.0.4): surface the upstream's own rejection reason (sanitized
    // summary only — never the raw body, never credential-shaped strings).
    const summary = sanitizeUpstreamRejection(parsed, bodyText)
    return errors.terminal(`invalid chat request rejected by upstream${summary ? `: ${summary}` : ''}`, {
      httpStatus: 400,
      ...(summary ? { detail: { upstreamSummary: summary } } : {}),
    })
  }
  return errors.terminal(`upstream HTTP ${status}`, { httpStatus: status })
}

/**
 * Build a short, credential-free summary of an upstream 4xx body for logging
 * and error propagation. Keeps only the upstream's own code/msg fields,
 * truncates, and strips anything that looks like a token/secret.
 */
export function sanitizeUpstreamRejection(
  parsed: Record<string, unknown> | undefined,
  bodyText: string,
): string {
  const parts: string[] = []
  if (parsed) {
    if (typeof parsed.code === 'number' || typeof parsed.code === 'string') parts.push(`code=${String(parsed.code).slice(0, 40)}`)
    const msg = typeof parsed.msg === 'string' ? parsed.msg
      : typeof parsed.message === 'string' ? parsed.message
        : typeof parsed.error === 'object' && parsed.error !== null && typeof (parsed.error as Record<string, unknown>).message === 'string'
          ? (parsed.error as { message: string }).message
          : ''
    if (msg) parts.push(`msg=${msg.slice(0, 200)}`)
  }
  if (parts.length === 0 && bodyText) {
    // Non-JSON body: keep a bounded, redacted excerpt so the shape is visible.
    parts.push(`body=${redactSecrets(bodyText).slice(0, 160)}`)
  }
  return redactSecrets(parts.join(' ')).slice(0, 240)
}

/** Strip anything resembling a bearer token / key / secret from free text. */
function redactSecrets(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/(token|key|secret|authorization|cookie)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/sk-[A-Za-z0-9]+/g, '<redacted>')
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
  // Non-streaming clients still need the tool calls — without them a
  // finish_reason='tool_calls' result is unactionable (Pi's "tool never
  // executed" symptom).
  if (toolOrder.length > 0) {
    result.toolCalls = toolOrder.map((i) => toolMap.get(i)!)
  }
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
    // Only NON-EMPTY increments count as content. Buddy-family upstreams send a
    // fixed delta envelope on every frame (`content`, `reasoning_content`,
    // `refusal`, `tool_calls`, …) and most of those fields are empty strings or
    // empty arrays. Treating "" / [] as real increments splits one upstream
    // frame into up to three downstream frames, two of which carry nothing —
    // a stream that is 67% empty shells and makes every token look like its own
    // event. Skipping empties keeps the wire 1:1 with real output.
    if (typeof delta.content === 'string' && delta.content.length > 0) frame.content = delta.content
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      frame.reasoning = delta.reasoning_content
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
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
