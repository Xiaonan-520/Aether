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

describe('developer role normalization (OpenAI GPT-5 instruction role)', () => {
  it('accepts a bare developer message and normalizes it to system, content preserved', () => {
    const req = parseChatCompletionsRequest({
      model: 'workbuddy::glm-5.3',
      messages: [{ role: 'developer', content: 'You are a coding agent.' }, { role: 'user', content: 'hi' }],
    })
    expect(req.messages[0]).toMatchObject({ role: 'system', content: 'You are a coding agent.' })
    expect(req.messages[1]).toMatchObject({ role: 'user', content: 'hi' })
  })

  it('preserves order and both messages when system AND developer are present (no dedup, no rewrite)', () => {
    const req = parseChatCompletionsRequest({
      model: 'workbuddy::glm-5.3',
      messages: [
        { role: 'system', content: 'base instructions' },
        { role: 'developer', content: 'extra policy' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'q2' },
      ],
    })
    expect(req.messages.map((m) => m.role)).toEqual(['system', 'system', 'user', 'assistant', 'user'])
    expect(req.messages[0].content).toBe('base instructions')
    expect(req.messages[1].content).toBe('extra policy')
  })

  it('keeps developer messages ahead of tool calls in multi-turn tool flows', () => {
    const req = parseChatCompletionsRequest({
      model: 'codebuddy::glm-5.3',
      messages: [
        { role: 'developer', content: 'policy' },
        { role: 'user', content: 'run it' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', content: 'result', tool_call_id: 't1' },
      ],
      tools: [{ type: 'function', function: { name: 'f' } }],
    })
    expect(req.messages[0]).toMatchObject({ role: 'system', content: 'policy' })
    expect(req.messages[2].toolCalls).toEqual([{ id: 't1', name: 'f', arguments: '{}' }])
    expect(req.messages[3]).toMatchObject({ role: 'tool', toolCallId: 't1' })
  })
})

describe('non-streaming tool_calls round-trip (Pi bash-not-executed fix)', () => {
  it('serializeChatCompletion emits standard tool_calls from ChatResult.toolCalls', async () => {
    const { serializeChatCompletion } = await import('../src/protocol/openai/serialize.js')
    const body = serializeChatCompletion(
      {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call_x', name: 'bash', arguments: '{"command":"pwd"}' }],
      },
      'workbuddy::glm-5.3',
    )
    const msg = (body.choices as Array<{ message: Record<string, unknown> }>)[0].message
    expect(msg.tool_calls).toEqual([
      { id: 'call_x', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
    ])
    expect(body.choices[0].finish_reason).toBe('tool_calls')
  })

  it('omits tool_calls when the result has none', async () => {
    const { serializeChatCompletion } = await import('../src/protocol/openai/serialize.js')
    const body = serializeChatCompletion({ content: 'hi', finishReason: 'stop' }, 'm')
    expect('tool_calls' in (body.choices as Array<{ message: Record<string, unknown> }>)[0].message).toBe(false)
  })
})
