/**
 * Regression tests for the 1.0.4 tool-call compatibility fixes (RikkaHub
 * Workspace scenario: JS Engine + AskUser tools, multi-turn tool result
 * backfill) plus the sanitized upstream-400 diagnostics.
 */
import { describe, expect, it } from 'vitest'
import { sanitizeUpstreamRejection, serializeMessages, upstreamError } from '../../src/provider/workbuddy/chat.js'
import { ProtocolError } from '../../src/protocol/errors.js'
import type { ExtensionChatRequest } from '../../src/protocol/types.js'

function chatMsg(m: unknown): ExtensionChatRequest['messages'] {
  return m as ExtensionChatRequest['messages']
}

describe('upstream 400 diagnostics (1.0.4)', () => {
  it('surfaces the upstream code/msg in the terminal error message', () => {
    const err = upstreamError(400, JSON.stringify({ code: 1201, msg: 'messages must alternate' }))
    expect(err).toBeInstanceOf(ProtocolError)
    expect(err.kind).toBe('TERMINAL')
    expect(err.message).toContain('invalid chat request rejected by upstream')
    expect(err.message).toContain('code=1201')
    expect(err.message).toContain('messages must alternate')
    expect(err.detail).toMatchObject({ upstreamSummary: expect.stringContaining('code=1201') })
  })

  it('falls back to a bounded body excerpt for non-JSON 400 bodies', () => {
    const err = upstreamError(400, '<html>bad request</html>')
    expect(err.message).toContain('body=<html>bad request</html>')
  })

  it('redacts secret-shaped strings in the summary', () => {
    const summary = sanitizeUpstreamRejection(undefined, 'token sk-abcdefghij1234567890ABCD leaked near field x')
    expect(summary).not.toContain('sk-abcdefghij1234567890ABCD')
    expect(summary).toContain('<redacted>')
  })

  it('keeps the summary bounded (≤240 chars)', () => {
    const long = 'x'.repeat(2000)
    expect(sanitizeUpstreamRejection({ code: 1, msg: long }, '').length).toBeLessThanOrEqual(240)
  })
})

describe('canonical tool-call wire shaping (1.0.4)', () => {
  it('accepts Core canonical camelCase toolCalls and emits OpenAI tool_calls', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'user', content: 'compute 1+1' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'javascript_engine', arguments: '{"code":"1+1"}' }] },
    ]))
    const assistant = wire[1] as Record<string, unknown>
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toBeNull()
    const calls = assistant.tool_calls as Array<{ id: string; type: string; function: { name: string; arguments: string } }>
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'javascript_engine', arguments: '{"code":"1+1"}' } })
  })

  it('passes through a matched tool result with tool_call_id', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'user', content: 'compute' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'ask_user', arguments: '{"q":"which db?"}' }] },
      { role: 'tool', content: 'postgres', toolCallId: 'call_1' },
    ]))
    const toolMsg = wire[2] as Record<string, unknown>
    expect(toolMsg).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'postgres' })
  })

  it('downgrades an orphan tool result (unmatched id) to a user note', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'stray result', toolCallId: 'call_missing' },
    ]))
    const downgraded = wire[1] as Record<string, unknown>
    expect(downgraded.role).toBe('user')
    expect(String(downgraded.content)).toContain('stray result')
    expect(String(downgraded.content)).toContain('call_missing')
  })

  it('downgrades a tool result with no id at all', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'tool', content: 'no id here' },
    ]))
    expect((wire[0] as Record<string, unknown>).role).toBe('user')
  })

  it('still accepts legacy snake_case tool_calls/tool_call_id from direct callers', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', content: 'ok', tool_call_id: 'c9' },
    ]))
    expect(((wire[0] as Record<string, unknown>).tool_calls as unknown[]).length).toBe(1)
    expect((wire[1] as Record<string, unknown>).tool_call_id).toBe('c9')
  })

  it('object arguments are stringified for the wire', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', arguments: { a: 1 } }] },
    ]))
    const calls = (wire[0] as Record<string, unknown>).tool_calls as Array<{ function: { arguments: string } }>
    expect(calls[0].function.arguments).toBe('{"a":1}')
  })
})
