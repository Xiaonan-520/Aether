/**
 * Anthropic Messages <-> canonical conversion for the ZCode adapter.
 *
 * ZCode's upstream speaks Anthropic Messages; the Gateway exposes OpenAI. Only
 * the translation lives here — the Gateway's own OpenAI serializer
 * (src/protocol/openai) still produces the client-facing output, so no second
 * OpenAI serializer is written.
 */
import type { ChatChunk, ChatRequest, ChatResult, Tool } from '../../core/types.js'

/** Canonical ChatRequest → Anthropic Messages request body. */
export function toAnthropicBody(req: ChatRequest, upstreamModel: string): Record<string, unknown> {
  const system: string[] = []
  const messages: Array<Record<string, unknown>> = []

  for (const message of req.messages) {
    if (message.role === 'system') {
      if (message.content) system.push(message.content)
      continue
    }
    if (message.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.toolCallId ?? '',
          content: message.content,
        }],
      })
      continue
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const blocks: Array<Record<string, unknown>> = []
      if (message.content) blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls) {
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
    messages.push({ role: message.role, content: [{ type: 'text', text: message.content }] })
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
  return body
}

interface AnthropicEvent {
  type?: string
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string }
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  usage?: { input_tokens?: number; output_tokens?: number }
  content_block?: { type?: string }
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
