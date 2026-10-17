/**
 * SSE encoding/decoding for the OpenAI wire format.
 *
 * encode: canonical ChatChunk stream → `data: {...}\n\n` frames ending with
 * `data: [DONE]\n\n`. decode: the inverse, used by tests and the mock upstream
 * (a provider adapter speaking OpenAI SSE can reuse it).
 */
import type { ChatChunk } from '../../core/types.js'
import { serializeChatChunk, newStreamContext } from './serialize.js'

const encoder = new TextEncoder()

export async function* encodeSseStream(
  chunks: AsyncIterable<ChatChunk>,
  model: string,
): AsyncIterable<Uint8Array> {
  const ctx = newStreamContext(model)
  for await (const chunk of chunks) {
    const frame = serializeChatChunk(chunk, ctx.model, ctx.id, ctx.created)
    yield encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
  }
  yield encoder.encode('data: [DONE]\n\n')
}

/** Parse an SSE byte/text stream into `data:` payload strings. */
export async function* parseSseData(
  stream: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string> {
  let buffer = ''
  for await (const part of stream) {
    buffer += typeof part === 'string' ? part : new TextDecoder().decode(part)
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      for (const line of rawEvent.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data:')) {
          yield trimmed.slice(5).trim()
        }
      }
    }
  }
}

/** Decode an OpenAI SSE `data:` payload stream back into ChatChunks. */
export async function* decodeSseStream(
  stream: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<ChatChunk> {
  for await (const data of parseSseData(stream)) {
    if (data === '[DONE]') return
    let parsed: {
      choices?: Array<{
        delta?: {
          content?: string
          reasoning_content?: string
          tool_calls?: Array<{ id?: string; index?: number; function?: { name?: string; arguments?: string } }>
        }
        finish_reason?: string | null
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      parsed = JSON.parse(data)
    } catch {
      continue // ignore keep-alive comments / non-JSON frames
    }
    const choice = parsed.choices?.[0]
    if (!choice) continue
    yield {
      text: choice.delta?.content ?? '',
      ...(choice.delta?.reasoning_content !== undefined
        ? { reasoning: choice.delta.reasoning_content }
        : {}),
      finishReason: (choice.finish_reason as ChatChunk['finishReason']) ?? null,
      ...(parsed.usage
        ? {
            usage: {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
            },
          }
        : {}),
      ...(choice.delta?.tool_calls
        ? {
            toolCalls: choice.delta.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.function?.name,
              arguments: tc.function?.arguments,
              ...(typeof tc.index === 'number' ? { index: tc.index } : {}),
            })),
          }
        : {}),
    }
  }
}
