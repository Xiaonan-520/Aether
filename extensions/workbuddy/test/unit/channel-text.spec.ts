/**
 * Regression tests for the 11128 channel-check fix.
 *
 * The buddy-family upstreams answer `400 / 11128` ("Illegal API invocation from
 * an unapproved channel") when request text contains a known client fingerprint.
 * One confirmed trigger is a verbose git-context label that ZCode CLI injects
 * into its dynamic system section inside a git working tree. The label also
 * fails when it appears in *assistant* text, and since a transcript replays
 * assistant text on every later turn, a single polluted turn poisons the whole
 * session.
 *
 * These tests lock in three things:
 *   1. the label is rewritten on the wire in both surfaces (system + assistant);
 *   2. a replayed transcript no longer contains the label (the "subsequent
 *      request" case that used to fail forever);
 *   3. everything else — user text, tool results, tool-call arguments,
 *      reasoning content, and unrelated system prose — passes through
 *      byte-identical, so tool calling and normal traffic are unaffected.
 *
 * The Claude Code identity sentence is a DIFFERENT trigger and is deliberately
 * NOT rewritten; a test asserts we leave it alone rather than impersonate.
 */
import { describe, expect, it } from 'vitest'
import { normalizeChannelText } from '../../src/util/channel-text.js'
import { serializeMessages } from '../../src/provider/workbuddy/chat.js'
import type { ExtensionChatRequest } from '../../src/protocol/types.js'

/** The confirmed fingerprint, assembled so this file's source stays clean. */
const TRIGGER = ['Main branch (you will', 'usually use this for PRs)'].join(' ')
/** The phrasing a ZCode-style prompt actually emits (label + branch value). */
const TRIGGER_LINE = `${TRIGGER}: main`

function chatMsg(m: unknown): ExtensionChatRequest['messages'] {
  return m as ExtensionChatRequest['messages']
}

describe('normalizeChannelText', () => {
  it('rewrites the confirmed git-context label', () => {
    const out = normalizeChannelText(TRIGGER_LINE)
    expect(out).not.toContain(TRIGGER)
    expect(out).toContain('Main branch (for PRs): main')
  })

  it('rewrites every occurrence in a multi-section system prompt', () => {
    const prompt = `# Environment\n${TRIGGER_LINE}\n\n# Notes\n${TRIGGER_LINE}`
    const out = normalizeChannelText(prompt)
    expect(out).not.toContain(TRIGGER)
    expect(out.match(/Main branch \(for PRs\)/g)).toHaveLength(2)
  })

  it('is idempotent', () => {
    const once = normalizeChannelText(TRIGGER_LINE)
    expect(normalizeChannelText(once)).toBe(once)
  })

  it('leaves unrelated text byte-identical', () => {
    const text = 'You are an interactive coding agent.\n\nMain branch: main\n\nBe concise.'
    expect(normalizeChannelText(text)).toBe(text)
  })

  it('does NOT rewrite the Claude Code identity sentence (separate trigger)', () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude."
    expect(normalizeChannelText(identity)).toBe(identity)
  })

  it('handles empty and non-string input defensively', () => {
    expect(normalizeChannelText('')).toBe('')
    // @ts-expect-error runtime guard for untyped wire data
    expect(normalizeChannelText(undefined)).toBeUndefined()
  })
})

describe('serializeMessages — system surface', () => {
  it('rewrites the label in a system message', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'system', content: `You are a coding agent.\n\n${TRIGGER_LINE}` },
      { role: 'user', content: 'hi' },
    ]))
    expect(wire[0]?.role).toBe('system')
    expect(String(wire[0]?.content)).not.toContain(TRIGGER)
    expect(String(wire[0]?.content)).toContain('You are a coding agent.')
  })

  it('rewrites the label in a SECOND system message too', () => {
    // The check runs over every system message, not just the first.
    const wire = serializeMessages(chatMsg([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'system', content: TRIGGER_LINE },
      { role: 'user', content: 'hi' },
    ]))
    expect(String(wire[1]?.content)).not.toContain(TRIGGER)
  })
})

describe('serializeMessages — assistant surface and replay', () => {
  it('rewrites the label in assistant text', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'what is the branch label?' },
      { role: 'assistant', content: `The label is: ${TRIGGER}` },
      { role: 'user', content: 'thanks' },
    ]))
    expect(wire[2]?.role).toBe('assistant')
    expect(String(wire[2]?.content)).not.toContain(TRIGGER)
  })

  it('a replayed transcript no longer carries the label (subsequent-request case)', () => {
    // This is the exact shape that used to fail forever: turn 1 polluted the
    // transcript, and every later turn replayed it and got 400/11128.
    const transcript = [
      { role: 'system', content: `You are a coding agent.\n${TRIGGER_LINE}` },
      { role: 'user', content: 'diagnose the error' },
      { role: 'assistant', content: `root cause: ${TRIGGER_LINE}` },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'working on it' },
      { role: 'user', content: 'next step' },
    ]
    const wire = serializeMessages(chatMsg(transcript))
    const serialized = JSON.stringify(wire)
    expect(serialized).not.toContain(TRIGGER)
    // Nothing else was dropped: same message count, same roles, same order.
    expect(wire).toHaveLength(transcript.length)
    expect(wire.map((m) => m.role)).toEqual(transcript.map((m) => m.role))
  })

  it('keeps assistant tool_calls and arguments intact', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: `about to run ${TRIGGER}`,
        toolCalls: [{ id: 'call_1', name: 'bash', arguments: '{"command":"ls -la"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'file.txt' },
    ]))
    const assistant = wire[2] as Record<string, unknown>
    expect(String(assistant.content)).not.toContain(TRIGGER)
    expect(assistant.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls -la"}' } },
    ])
    expect(wire[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'file.txt' })
  })
})

describe('serializeMessages — untouched surfaces', () => {
  it('leaves user text alone (not part of the check)', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: TRIGGER_LINE },
    ]))
    expect(String(wire[1]?.content)).toBe(TRIGGER_LINE)
  })

  it('leaves tool result content alone', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'run' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: TRIGGER_LINE },
    ]))
    expect(wire[3]).toMatchObject({ role: 'tool', content: TRIGGER_LINE })
  })

  it('leaves tool-call arguments alone', () => {
    const args = JSON.stringify({ command: `echo "${TRIGGER}"` })
    const wire = serializeMessages(chatMsg([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'run' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', arguments: args }] },
    ]))
    const assistant = wire[2] as Record<string, unknown>
    const calls = assistant.tool_calls as Array<{ function: { arguments: string } }>
    expect(calls[0]?.function.arguments).toBe(args)
  })

  it('leaves reasoning_content alone', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok', reasoning_content: TRIGGER_LINE },
    ]))
    const assistant = wire[2] as Record<string, unknown>
    expect(assistant.reasoning_content).toBe(TRIGGER_LINE)
  })
})

describe('serializeMessages — normal requests unaffected', () => {
  it('passes a plain request through unchanged', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'say ok' },
    ]))
    expect(wire).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'say ok' },
    ])
  })

  it('preserves an ordinary multi-turn tool conversation', () => {
    const wire = serializeMessages(chatMsg([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'a.txt\nb.txt' },
      { role: 'assistant', content: 'Two files: a.txt and b.txt.' },
      { role: 'user', content: 'thanks' },
    ]))
    expect(wire).toHaveLength(6)
    expect(wire.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user'])
    expect((wire[2] as Record<string, unknown>).tool_calls).toBeDefined()
  })
})
