/**
 * MiniMax protocol translation (OpenAI-compatible ↔ Anthropic Messages).
 *
 * Pure-function tests lock the wire shapes: system hoisting, tool_use /
 * tool_result pairing, the "no thinking field" default, and the SSE event
 * mapping (including the signature_delta that must never become text).
 */
import { describe, expect, it } from 'vitest'
import {
  buildMinimaxPayload,
  mapStopReason,
  parseMinimaxEvent,
  MINIMAX,
  MINIMAX_INTL,
} from '../src/providers/minimax/protocol.js'

describe('buildMinimaxPayload', () => {
  it('hoists system + developer into the top-level system field', () => {
    const p = buildMinimaxPayload({
      model: 'MiniMax-M3',
      messages: [
        { role: 'system', content: 'A' },
        { role: 'developer', content: 'B' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(p.system).toBe('A\n\nB')
    expect((p.messages as Array<{ role: string }>).some((m) => m.role === 'system')).toBe(false)
    expect(p.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('omits the system field when there is no system message', () => {
    const p = buildMinimaxPayload({ model: 'M', messages: [{ role: 'user', content: 'x' }] })
    expect('system' in p).toBe(false)
  })

  it('maps assistant tool_calls to tool_use blocks with parsed input', () => {
    const p = buildMinimaxPayload({
      model: 'M',
      messages: [
        { role: 'user', content: 'run' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
      ],
    })
    const msgs = p.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } }],
    })
    expect(msgs[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'a.txt' }],
    })
  })

  it('drops orphan tool results (upstream 400s on them)', () => {
    const p = buildMinimaxPayload({
      model: 'M',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'tool', tool_call_id: 'ghost', content: 'stale' },
      ],
    })
    expect(JSON.stringify(p.messages)).not.toContain('ghost')
  })

  it('drops tool_use blocks whose result never arrives (orphan the other way)', () => {
    const p = buildMinimaxPayload({
      model: 'M',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c9', function: { name: 'bash', arguments: '{}' } }] },
      ],
    })
    const s = JSON.stringify(p.messages)
    expect(s).not.toContain('tool_use')
    expect((p.messages as unknown[]).length).toBe(2)
  })

  it('never fabricates tool input when arguments are invalid JSON', () => {
    const p = buildMinimaxPayload({
      model: 'M',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: 'not json' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'r' },
      ],
    })
    const msgs = p.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(msgs[1]!.content[0]).toMatchObject({ type: 'tool_use', input: {} })
  })

  it('sends NO thinking field by default (disabled is a hard 400 on M3.1)', () => {
    const p = buildMinimaxPayload({ model: 'M', messages: [{ role: 'user', content: 'x' }] })
    expect('thinking' in p).toBe(false)
  })

  it('maps canonical tools ({name,...}) to Anthropic input_schema', () => {
    const p = buildMinimaxPayload({
      model: 'M',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
    })
    expect(p.tools).toEqual([{ name: 'bash', description: 'run', input_schema: { type: 'object' } }])
  })

  it('also accepts OpenAI-shaped tools as a fallback', () => {
    const p = buildMinimaxPayload({
      model: 'M',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } }],
    })
    expect(p.tools).toEqual([{ name: 'bash', description: 'run', input_schema: { type: 'object' } }])
  })

  it('always streams', () => {
    expect(buildMinimaxPayload({ model: 'M', messages: [] }).stream).toBe(true)
  })
})

describe('product configs', () => {
  it('the two sites differ only in the six documented fields', () => {
    expect(MINIMAX.id).toBe('minimax')
    expect(MINIMAX_INTL.id).toBe('minimaxintl')
    expect(MINIMAX.apiHost).toBe('https://agent.minimax.cn')
    expect(MINIMAX_INTL.apiHost).toBe('https://agent.minimax.io')
    expect(MINIMAX.region).toBe('cn')
    expect(MINIMAX_INTL.region).toBe('en')
    // shared protocol constants
    expect(MINIMAX.inferPath).toBe(MINIMAX_INTL.inferPath)
    expect(MINIMAX.clientId).toBe(MINIMAX_INTL.clientId)
    expect(MINIMAX.scope).toBe(MINIMAX_INTL.scope)
    expect(MINIMAX.audience).toBe(MINIMAX_INTL.audience)
  })
})

describe('parseMinimaxEvent', () => {
  it('ignores ping', () => {
    expect(parseMinimaxEvent('{"type":"ping"}')).toEqual([])
  })

  it('maps text_delta to text', () => {
    expect(parseMinimaxEvent('{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}'))
      .toEqual([{ text: 'hi' }])
  })

  it('maps thinking_delta to reasoning', () => {
    expect(parseMinimaxEvent('{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}'))
      .toEqual([{ text: '', reasoning: 'hmm' }])
  })

  it('NEVER turns signature_delta into text', () => {
    const out = parseMinimaxEvent('{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc123"}}')
    expect(out).toEqual([])
  })

  it('emits no increment for an empty text_delta', () => {
    expect(parseMinimaxEvent('{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}'))
      .toEqual([])
  })

  it('maps tool_use start to a tool call with id+name', () => {
    const out = parseMinimaxEvent('{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"c1","name":"bash"}}')
    expect(out[0]?.toolCalls?.[0]).toMatchObject({ id: 'c1', name: 'bash', index: 1 })
  })

  it('maps input_json_delta to argument fragments', () => {
    const out = parseMinimaxEvent('{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}')
    expect(out[0]?.toolCalls?.[0]?.arguments).toBe('{"a":1}')
  })

  it('maps stop_reason', () => {
    expect(mapStopReason('end_turn')).toBe('stop')
    expect(mapStopReason('max_tokens')).toBe('length')
    expect(mapStopReason('tool_use')).toBe('tool_calls')
    const out = parseMinimaxEvent('{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}')
    expect(out[0]).toMatchObject({ finishReason: 'tool_calls', usage: { completionTokens: 9 } })
  })

  it('raises a classified error for an error event', () => {
    expect(() => parseMinimaxEvent('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'))
      .toThrow(/slow down/)
  })

  it('ignores malformed JSON', () => {
    expect(parseMinimaxEvent('not json')).toEqual([])
  })
})
