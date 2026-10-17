/**
 * Accio protocol translation tests. Locks the traps documented from the
 * reference implementation: token in body, string system_instruction, empty
 * empid/tenant/iaiTag, stringified tool schemas, the un-converted properties
 * subtree, and the thought/text/functionCall SSE mapping.
 */
import { describe, expect, it } from 'vitest'
import {
  buildAccioBody,
  accioSgK,
  accioMessageId,
  accioToSnake,
  parseAccioEvent,
  toAccioTools,
  ACCIO,
} from '../src/providers/accio/protocol.js'

describe('buildAccioBody', () => {
  const base = {
    model: '1Nexus-R3wF8qJ5vB6h',
    accessToken: 'tok',
    utdid: 'u1',
    requestId: 'req-1',
    messages: [{ role: 'user' as const, content: 'hi' }],
  }

  it('puts the token in the BODY, not headers', () => {
    const b = buildAccioBody(base)
    expect(b.token).toBe('tok')
  })

  it('produces a STRING system_instruction', () => {
    const b = buildAccioBody({ ...base, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }] })
    expect(b.system_instruction).toBe('S')
    expect(typeof b.system_instruction).toBe('string')
  })

  it('concatenates multiple system/developer messages', () => {
    const b = buildAccioBody({ ...base, messages: [
      { role: 'system', content: 'A' }, { role: 'developer', content: 'B' }, { role: 'user', content: 'x' },
    ] })
    expect(b.system_instruction).toBe('A\n\nB')
  })

  it('omits system_instruction when empty', () => {
    const b = buildAccioBody(base)
    expect('system_instruction' in b).toBe(false)
  })

  it('uses empty strings for empid/tenant/iai_tag', () => {
    const b = buildAccioBody(base)
    expect(b.empid).toBe('')
    expect(b.tenant).toBe('')
    expect(b.iai_tag).toBe('')
  })

  it('requires a message_id', () => {
    const b = buildAccioBody(base)
    expect(typeof b.message_id).toBe('string')
    expect((b.message_id as string).length).toBe(32)
  })

  it('message_id differs across calls with the same requestId', () => {
    expect(buildAccioBody(base).message_id).not.toBe(buildAccioBody(base).message_id)
  })

  it('keeps the properties subtree un-converted', () => {
    const b = buildAccioBody(base)
    expect(b.properties).toEqual({ utdid: 'u1', version: ACCIO.appVersion, appKey: 'OneChat', normalized_response: 'true' })
  })

  it('stringifies tool schemas (parameters_json)', () => {
    const b = buildAccioBody({ ...base, tools: [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } }] })
    const tools = b.tools as Array<{ name: string; parameters_json: string }>
    expect(tools[0]?.parameters_json).toContain('"filePath"')
    // the recursive snake rewrite must NOT have renamed the schema key
    expect(tools[0]?.parameters_json).not.toContain('file_path')
  })

  it('accepts OpenAI-shaped tools too', () => {
    const b = buildAccioBody({ ...base, tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }] })
    expect((b.tools as Array<{ name: string }>)[0]?.name).toBe('bash')
  })

  it('converts user/assistant/tool messages to Gemini-style contents', () => {
    const b = buildAccioBody({
      ...base,
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'out' },
      ],
    })
    const msgs = b.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>
    expect(msgs[1]?.role).toBe('model')
    // accioToSnake rewrote camelCase to snake_case — that IS the wire shape
    expect(msgs[1]?.parts[0]).toEqual({ function_call: { name: 'bash', args: { command: 'ls' } } })
    expect(msgs[2]?.parts[0]).toEqual({ function_response: { name: 'c1', response: { result: 'out' } } })
  })

  it('streams', () => {
    expect(buildAccioBody(base).incremental).toBe(true)
  })

  it('sg_k is md5(requestId)', () => {
    expect(accioSgK('req-1')).toBe(require('node:crypto').createHash('md5').update('req-1').digest('hex'))
  })

  it('toSnake drops undefined keys', () => {
    expect(accioToSnake({ a: 1, b: undefined, cD: 2 })).toEqual({ a: 1, c_d: 2 })
  })
})

describe('parseAccioEvent', () => {
  it('maps text parts', () => {
    expect(parseAccioEvent('{"content":{"parts":[{"text":"hi"}]}}')).toEqual([{ text: 'hi' }])
  })

  it('maps thought parts to reasoning', () => {
    expect(parseAccioEvent('{"content":{"parts":[{"text":"hmm","thought":true}]}}'))
      .toEqual([{ text: '', reasoning: 'hmm' }])
  })

  it('maps functionCall to a tool call with generated id', () => {
    const out = parseAccioEvent('{"content":{"parts":[{"functionCall":{"name":"bash","args":{"command":"ls"}}}]}}')
    expect(out[0]?.toolCalls?.[0]).toMatchObject({ name: 'bash', arguments: '{"command":"ls"}' })
    expect(out[0]?.finishReason).toBe('tool_calls')
  })

  it('raises a classified error for in-stream error_code', () => {
    expect(() => parseAccioEvent('{"error_code":402,"error_message":"pay"}')).toThrow(/pay/)
    try {
      parseAccioEvent('{"error_code":402,"error_message":"pay"}')
    } catch (e) {
      expect((e as { upKind?: string }).upKind).toBe('AUTH_INVALID')
    }
  })

  it('ignores malformed JSON', () => {
    expect(parseAccioEvent('nope')).toEqual([])
  })

  it('attaches usage metadata', () => {
    const out = parseAccioEvent('{"content":{"parts":[{"text":"a"}]},"usage_metadata":{"prompt_token_count":3,"candidates_token_count":4}}')
    expect(out[0]?.usage).toEqual({ promptTokens: 3, completionTokens: 4 })
  })
})

describe('ACCIO product', () => {
  it('uses one gateway for both regions and distinct login hosts', () => {
    expect(ACCIO.gatewayBaseUrl).toBe('https://phoenix-gw.alibaba.com')
    expect(ACCIO.loginBaseUrlOf('cn')).toBe('https://www.accio-ai.com')
    expect(ACCIO.loginBaseUrlOf('global')).toBe('https://zh.accio.com')
  })
})
