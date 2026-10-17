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
          ...(result.toolCalls !== undefined && result.toolCalls.length > 0
            ? {
                // Standard OpenAI tool_calls shape; arguments arrive as the
                // upstream's raw JSON text, unchanged.
                tool_calls: result.toolCalls.map((tc, i) => ({
                  id: tc.id ?? `call_${i}`,
                  type: 'function',
                  function: { name: tc.name ?? '', arguments: tc.arguments ?? '' },
                })),
              }
            : {}),
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
    // Extension chunks emit per-frame fragments of the same logical call
    // sequence; the fragment list position IS the stable wire index (resetting
    // it per frame would fold parallel calls into index 0). The name is only
    // sent when actually present — OpenAI clients treat an explicit name field
    // (even "") as authoritative, so serializing `name:''` on argument-delta
    // frames would overwrite the real name downstream and poison history with
    // empty-name tool calls (upstream then 400s with 11148/11133).
    delta.tool_calls = chunk.toolCalls.map((tc, i) => ({
      index: typeof tc.index === 'number' ? tc.index : i,
      ...(tc.id ? { id: tc.id } : {}),
      type: 'function',
      function: {
        ...(tc.name ? { name: tc.name } : {}),
        arguments: tc.arguments ?? '',
      },
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
