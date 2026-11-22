/**
 * Anthropic Messages <-> canonical conversion for the ZCode adapter.
 *
 * ZCode's upstream speaks Anthropic Messages; the Gateway exposes OpenAI. Only
 * the translation lives here — the Gateway's own OpenAI serializer
 * (src/protocol/openai) still produces the client-facing output, so no second
 * OpenAI serializer is written.
 */
import type { ChatChunk, ChatResult, Tool } from '../../protocol/types.js'
import type { ExtensionChatRequest } from '../../protocol/types.js'
import { randomUUID } from 'node:crypto'
import { buildCurrentDateMessage, buildStartPlanSystem } from './system-prompt.js'

/** Which upstream gateway the request targets; start-plan needs extra shaping. */
export type ZCodePlan = 'coding-plan' | 'start-plan'

/** Canonical ChatRequest → Anthropic Messages request body. */
export function toAnthropicBody(
  req: ExtensionChatRequest,
  upstreamModel: string,
  plan: ZCodePlan = 'coding-plan',
): Record<string, unknown> {
  const system: string[] = []
  const messages: Array<Record<string, unknown>> = []

  for (const message of req.messages) {
    if (message.role === 'system') {
      const text = typeof message.content === 'string' ? message.content : ''
      if (text) system.push(text)
      continue
    }
    if (message.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: (message as { toolCallId?: unknown }).toolCallId ?? (message as { tool_call_id?: unknown }).tool_call_id ?? '',
          content: typeof message.content === 'string' ? message.content : '',
        }],
      })
      continue
    }
    const toolCalls = (message as { toolCalls?: unknown; tool_calls?: unknown }).toolCalls
      ?? (message as { tool_calls?: unknown }).tool_calls
    if (message.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length > 0) {
      const blocks: Array<Record<string, unknown>> = []
      const text = typeof message.content === 'string' ? message.content : ''
      if (text) blocks.push({ type: 'text', text })
      for (const call of toolCalls as Array<{ id?: string; name?: string; arguments?: string }>) {
        let input: unknown = {}
        try {
          input = JSON.parse(call.arguments || '{}')
        } catch {
          input = {}
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input })
      }
      messages.push({ role: 'assistant', content: blocks })
      continue
    }
    // Anthropic requires block-array content, never a bare string.
    messages.push({ role: message.role, content: [{ type: 'text', text: typeof message.content === 'string' ? message.content : '' }] })
  }

  const body: Record<string, unknown> = {
    model: upstreamModel,
    messages,
    stream: req.stream,
    max_tokens: req.maxTokens ?? 4096,
  }
  if (system.length > 0) body.system = system.join('\n\n')
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((tool: Tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters ?? { type: 'object', properties: {} },
    }))
  }
  if (plan === 'start-plan') applyStartPlanShape(body, messages, system.join('\n\n'))
  return body
}

/**
 * start-plan request shape (mirrors TriDefender/zcode-api `applyStartPlanSystem`
 * + `buildAnthropicMetadataUserId`).
 *
 * Three changes, all required by the start-plan edge:
 *   1. `system` becomes the three identity blocks — the edge inspects this
 *      field and answers 3012 when the ZCode anchor is missing.
 *   2. a leading user turn carrying the date attachment.
 *   3. `metadata.user_id` = the device/session blob the real client sends
 *      (`account_uuid` is always ""; we have no deviceMid, so it is omitted).
 * Tool-level `cache_control` is dropped: start-plan carries a single
 * breakpoint on the stable block and rejects extra ones.
 */
function applyStartPlanShape(
  body: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
  existingSystem: string | undefined,
): void {
  body.system = buildStartPlanSystem(existingSystem)
  if (messages.length > 0) messages.unshift(buildCurrentDateMessage() as unknown as Record<string, unknown>)
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool && typeof tool === 'object' && 'cache_control' in tool) {
        delete (tool as Record<string, unknown>).cache_control
      }
    }
  }
  body.metadata = {
    user_id: JSON.stringify({ account_uuid: '', session_id: bodySessionId() }),
  }
}

/** Session id for the start-plan metadata blob (stable per process is enough). */
function bodySessionId(): string {
  if (!_sessionId) _sessionId = randomUUID().replace(/-/g, '')
  return _sessionId
}
let _sessionId = ''

import { errors } from '../../protocol/errors.js'

interface AnthropicEvent {
  type?: string
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string }
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  usage?: { input_tokens?: number; output_tokens?: number }
  content_block?: { type?: string }
  error?: { message?: string }
}

/** One Anthropic SSE event → canonical chunk (or undefined when ignorable). */
export function anthropicEventToChunk(event: AnthropicEvent): ChatChunk | undefined {
  if (event.type === 'content_block_delta' && event.delta) {
    if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
      return { text: event.delta.text }
    }
    if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
      return { text: '', reasoning: event.delta.thinking }
    }
    return undefined
  }
  // mid-stream upstream failure: surface it instead of ending the stream as a
  // clean stop (which would report success and truncate the client's text)
  if (event.type === 'error') {
    const detail = event.error && typeof event.error.message === 'string' ? event.error.message : 'upstream stream error'
    throw errors.upstream5xx(`zcode: ${detail}`)
  }
  if (event.type === 'message_delta') {
    const stop = event.delta?.stop_reason
    const usage = event.usage ?? event.message?.usage
    const chunk: ChatChunk = { text: '' }
    if (stop === 'end_turn' || stop === 'stop_sequence') chunk.finishReason = 'stop'
    else if (stop === 'max_tokens') chunk.finishReason = 'length'
    else if (stop === 'tool_use') chunk.finishReason = 'tool_calls'
    if (usage) chunk.usage = { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens }
    return chunk
  }
  return undefined
}

/** Read a non-streaming Anthropic response into a canonical ChatResult. */
export function fromAnthropicResponse(json: Record<string, unknown>): ChatResult {
  const blocks = Array.isArray(json.content) ? (json.content as Array<Record<string, unknown>>) : []
  let text = ''
  let reasoning: string | undefined
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      reasoning = (reasoning ?? '') + block.thinking
    }
  }
  const usage = json.usage as { input_tokens?: number; output_tokens?: number } | undefined
  const stop = typeof json.stop_reason === 'string' ? json.stop_reason : 'stop'
  return {
    content: text,
    reasoning,
    finishReason: stop === 'end_turn' || stop === 'stop_sequence' ? 'stop'
      : stop === 'max_tokens' ? 'length'
        : stop === 'tool_use' ? 'tool_calls' : stop,
    usage: usage ? { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens } : undefined,
  }
}
