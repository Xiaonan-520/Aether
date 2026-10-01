/**
 * Canonical chat results/chunks → OpenAI ChatCompletion JSON.
 * Streaming produces `chat.completion.chunk` objects; the final frame carries
 * usage when the adapter reported it.
 */
import { randomUUID } from 'node:crypto'
import type { ChatChunk, ChatResult } from '../../core/types.js'

const CREATED = () => Math.floor(Date.now() / 1000)

export interface CompletionUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

function baseCompletion(id: string, model: string, systemFingerprint?: string) {
  return {
    id,
    object: 'chat.completion' as const,
    created: CREATED(),
    model,
    system_fingerprint: systemFingerprint ?? 'gateway',
  }
}

export function serializeChatCompletion(
  result: ChatResult,
  model: string,
): Record<string, unknown> {
  return {
    ...baseCompletion(`chatcmpl-${randomUUID()}`, model),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.content,
          ...(result.reasoning !== undefined ? { reasoning_content: result.reasoning } : {}),
        },
        finish_reason: result.finishReason,
      },
    ],
    ...(result.usage
      ? {
          usage: {
            prompt_tokens: result.usage.promptTokens ?? 0,
            completion_tokens: result.usage.completionTokens ?? 0,
            total_tokens: (result.usage.promptTokens ?? 0) + (result.usage.completionTokens ?? 0),
          },
        }
      : {}),
  }
}

export function serializeChatChunk(
  chunk: ChatChunk,
  model: string,
  id: string,
  created: number,
): Record<string, unknown> {
  const delta: Record<string, unknown> = {}
  if (chunk.text !== '') delta.content = chunk.text
  if (chunk.reasoning !== undefined) delta.reasoning_content = chunk.reasoning
  if (chunk.toolCalls !== undefined) {
    delta.tool_calls = chunk.toolCalls.map((tc, i) => ({
      index: i,
      ...(tc.id ? { id: tc.id } : {}),
      type: 'function',
      function: { name: tc.name ?? '', arguments: tc.arguments ?? '' },
    }))
  }
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    system_fingerprint: 'gateway',
    choices: [
      {
        index: 0,
        delta,
        finish_reason: chunk.finishReason ?? null,
      },
    ],
    ...(chunk.usage
      ? {
          usage: {
            prompt_tokens: chunk.usage.promptTokens ?? 0,
            completion_tokens: chunk.usage.completionTokens ?? 0,
          },
        }
      : {}),
  }
}

/** Helper for SSE emitters: a stable id/created pair for one streamed response. */
export function newStreamContext(model: string): { id: string; created: number; model: string } {
  return { id: `chatcmpl-${randomUUID()}`, created: CREATED(), model }
}
