import { describe, expect, it } from 'vitest'
import { parseChatCompletionsRequest, OpenAIApiError } from '../src/protocol/openai/parse.js'
import {
  serializeChatCompletion,
  serializeChatChunk,
  newStreamContext,
} from '../src/protocol/openai/serialize.js'
import { encodeSseStream, decodeSseStream } from '../src/protocol/openai/sse.js'
import type { ChatChunk, ChatRequest } from '../src/core/types.js'

describe('openai parse', () => {
  it('parses a full streaming request with tools', () => {
    const req = parseChatCompletionsRequest({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
      max_tokens: 100,
      temperature: 0.5,
      tools: [
        { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
      ],
    })
    expect(req).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: true,
      maxTokens: 100,
      temperature: 0.5,
      tools: [{ name: 'get_weather', parameters: { type: 'object' } }],
    })
    expect(req.messages).toHaveLength(2)
    expect(req.messages[0]).toMatchObject({ role: 'system', content: 'be brief' })
  })

  it('defaults stream to false and normalizes tool_calls messages', () => {
    const req = parseChatCompletionsRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{"x":1}' } }],
        },
        { role: 'tool', content: 'result', tool_call_id: 't1' },
      ],
    })
    expect(req.stream).toBe(false)
    expect(req.messages[0].toolCalls).toEqual([{ id: 't1', name: 'f', arguments: '{"x":1}' }])
    expect(req.messages[1].toolCallId).toBe('t1')
  })

  it('rejects invalid requests as OpenAIApiError(400)', () => {
    try {
      parseChatCompletionsRequest({ model: '', messages: [] })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(OpenAIApiError)
      expect((err as OpenAIApiError).status).toBe(400)
    }
    expect(() => parseChatCompletionsRequest({ messages: [{ role: 'user', content: 'x' }] }))
      .toThrow(OpenAIApiError)
  })
})

describe('openai serialize', () => {
  it('serializes a non-streaming completion with usage', () => {
    const out = serializeChatCompletion(
      { content: 'hello', finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 2 } },
      'deepseek-v4-flash',
    )
    expect(out).toMatchObject({
      object: 'chat.completion',
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
  })

  it('serializes stream chunks with delta and [DONE]-free frames', () => {
    const ctx = newStreamContext('m1')
    const frame = serializeChatChunk({ text: 'he', finishReason: null }, ctx.model, ctx.id, ctx.created)
    expect(frame).toMatchObject({
      object: 'chat.completion.chunk',
      id: ctx.id,
      choices: [{ delta: { content: 'he' }, finish_reason: null }],
    })
  })
})

describe('openai sse', () => {
  async function* chunks(): AsyncGenerator<ChatChunk> {
    yield { text: 'he', finishReason: null }
    yield { text: 'llo', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2 } }
  }

  async function* toTextStream(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
    for await (const b of bytes) yield new TextDecoder().decode(b)
  }

  it('encodes frames and decodes them back to canonical chunks', async () => {
    const text = [...await collect(toTextStream(encodeSseStream(chunks(), 'm1')))].join('')
    expect(text).toContain('"object":"chat.completion.chunk"')
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)

    async function* replay(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode(text)
    }
    const decoded = await collect(decodeSseStream(replay()))
    expect(decoded.map((c) => c.text).join('')).toBe('hello')
    expect(decoded[1].finishReason).toBe('stop')
    expect(decoded[1].usage).toEqual({ promptTokens: 1, completionTokens: 2 })
  })

  it('skips malformed frames and comments', async () => {
    async function* raw(): AsyncGenerator<string> {
      yield ': keep-alive\n\n'
      yield 'data: not-json\n\n'
      yield 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n'
      yield 'data: [DONE]\n\n'
    }
    const out = await collect(decodeSseStream(raw()))
    expect(out.map((c) => c.text)).toEqual(['ok'])
  })
})

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of gen) out.push(item)
  return out
}
