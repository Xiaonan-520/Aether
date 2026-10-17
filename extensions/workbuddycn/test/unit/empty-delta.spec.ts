/**
 * Regression tests for empty-delta suppression on the streaming path.
 *
 * The buddy-family upstreams send a FIXED delta envelope on every frame:
 *
 *     { role, content, reasoning_content, function_call,
 *       refusal, tool_calls, extra_fields }
 *
 * On a given frame most of those fields are empty (`content: ""`,
 * `reasoning_content: ""`, `tool_calls: []`). The extension used to treat
 * `reasoning_content: ""` and `tool_calls: []` as real increments and emit a
 * separate downstream frame for each, so one upstream token became up to three
 * SSE frames — two of them carrying nothing. Measured on the real upstream that
 * was 67% empty shells interleaved with the actual content deltas.
 *
 * These tests drive the FULL extension over HTTP with a scripted upstream that
 * reproduces that envelope, then assert on the frames the client actually
 * receives. This is stronger than unit-testing the parser: it covers the
 * chat + stream assembly, not just `parseUpstreamFrame`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHarness, parseSse, type HarnessResult } from './helpers.js'

/** One upstream frame with the full buddy envelope (most fields empty). */
function envelope(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { refusal: '', function_call: {}, extra_fields: {}, ...delta }, finish_reason: null }],
  })}`
}

describe('empty-delta suppression (11128-era upstream envelope)', () => {
  let h: HarnessResult

  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    if (h) await h.close()
  })

  /** Mirrors the other provider specs: create the account, then poll until active. */
  async function login(): Promise<string> {
    const id = `wbcn-${Math.random().toString(36).slice(2, 8)}`
    await h.request('POST', '/v1/accounts', { accountId: id, loginMode: 'external-link' })
    h.fake.behaviour.tokenReadyAfterPolls = 1
    for (let i = 0; i < 20; i++) {
      const detail = await h.request('GET', `/v1/accounts/${id}`)
      const status = ((await detail.json()).account as Record<string, unknown>).status
      if (status === 'active') return id
    }
    throw new Error('login did not complete')
  }

  async function streamFrames(accountId: string): Promise<Array<Record<string, unknown>>> {
    const res = await h.request('POST', '/v1/chat', {
      accountId,
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    return parseSse(text).map((f) => ({ ...f.data, __event: f.event }))
  }

  /**
   * Extension SSE frames are `event: chunk|done|error` + `data: ChatChunk`.
   * Keep the event name alongside the payload so assertions can be explicit.
   */
  const chunkDeltas = (frames: Array<Record<string, unknown>>) =>
    frames.filter((f) => f.__event === 'chunk')

  it('emits NO empty reasoning_content frames (upstream sends "" on every frame)', async () => {
    h.fake.behaviour.chatScript = () => ({
      kind: 'stream',
      frames: [
        // first frame is the classic role frame: everything empty
        envelope({ role: 'assistant', content: '', reasoning_content: '', tool_calls: [] }),
        envelope({ content: 'Hello', reasoning_content: '', tool_calls: [] }),
        envelope({ content: ' World', reasoning_content: '', tool_calls: [] }),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}`,
        'data: [DONE]',
      ],
    })
    const frames = await streamFrames(await login())
    const deltas = chunkDeltas(frames)

    for (const d of deltas) {
      if ('reasoning' in d) expect(d.reasoning).not.toBe('')
    }
    expect(deltas.some((d) => d.reasoning === '')).toBe(false)
  })

  it('emits NO empty tool_calls frames', async () => {
    h.fake.behaviour.chatScript = () => ({
      kind: 'stream',
      frames: [
        envelope({ content: 'a', reasoning_content: '', tool_calls: [] }),
        envelope({ content: 'b', reasoning_content: '', tool_calls: [] }),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ],
    })
    const deltas = chunkDeltas(await streamFrames(await login()))
    expect(deltas.some((d) => Array.isArray(d.toolCalls) && d.toolCalls.length === 0)).toBe(false)
  })

  it('keeps the content text complete and in order (no loss, no duplication)', async () => {
    h.fake.behaviour.chatScript = () => ({
      kind: 'stream',
      frames: [
        envelope({ content: '', reasoning_content: '', tool_calls: [] }),
        envelope({ content: 'The ', reasoning_content: '', tool_calls: [] }),
        envelope({ content: 'quick ', reasoning_content: '', tool_calls: [] }),
        envelope({ content: 'brown fox', reasoning_content: '', tool_calls: [] }),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ],
    })
    const deltas = chunkDeltas(await streamFrames(await login()))
    const text = deltas.map((d) => (d.text as string) ?? '').join('')
    expect(text).toBe('The quick brown fox')
  })

  it('still forwards NON-EMPTY reasoning deltas', async () => {
    h.fake.behaviour.chatScript = () => ({
      kind: 'stream',
      frames: [
        envelope({ reasoning_content: 'Let me think', content: '', tool_calls: [] }),
        envelope({ reasoning_content: ' about it.', content: '', tool_calls: [] }),
        envelope({ content: 'Answer', reasoning_content: '', tool_calls: [] }),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ],
    })
    const deltas = chunkDeltas(await streamFrames(await login()))
    const reasoning = deltas.map((d) => (d.reasoning as string) ?? '').join('')
    expect(reasoning).toBe('Let me think about it.')
    // every reasoning frame is a real increment
    for (const d of deltas) {
      if ('reasoning' in d) expect((d.reasoning as string).length).toBeGreaterThan(0)
    }
  })

  it('still forwards real tool calls (and their fragments)', async () => {
    h.fake.behaviour.chatScript = () => ({
      kind: 'stream',
      frames: [
        envelope({
          reasoning_content: '',
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"comm' } }],
        }),
        envelope({ tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
        'data: [DONE]',
      ],
    })
    const frames = await streamFrames(await login())
    const deltas = chunkDeltas(frames)
    const withCalls = deltas.filter((d) => Array.isArray(d.toolCalls) && d.toolCalls.length > 0)
    expect(withCalls.length).toBeGreaterThanOrEqual(2)
    expect(withCalls[0]?.toolCalls).toMatchObject([{ id: 'call_1', name: 'bash' }])
    const args = withCalls.map((d) => (d.toolCalls as Array<{ arguments?: string }>)[0]?.arguments ?? '').join('')
    expect(args).toBe('{"command":"ls"}')
    // terminal frame still reports the tool_calls finish reason
    const done = frames.find((f) => f.__event === 'done')
    expect(done?.finishReason).toBe('tool_calls')
  })

  it('terminates correctly with a single done frame and no duplicate content', async () => {
    h.fake.behaviour.chatScript = () => ({
      kind: 'stream',
      frames: [
        envelope({ content: 'only', reasoning_content: '', tool_calls: [] }),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ],
    })
    const frames = await streamFrames(await login())
    const doneFrames = frames.filter((f) => f.__event === 'done')
    expect(doneFrames).toHaveLength(1)
    expect(doneFrames[0]?.finishReason).toBe('stop')
    const text = chunkDeltas(frames).map((d) => (d.text as string) ?? '').join('')
    expect(text).toBe('only')
  })

  it('a frame containing only empty fields produces no downstream chunk at all', async () => {
    h.fake.behaviour.chatScript = () => ({
      kind: 'stream',
      frames: [
        envelope({ role: 'assistant', content: '', reasoning_content: '', tool_calls: [] }),
        envelope({ content: 'x', reasoning_content: '', tool_calls: [] }),
        envelope({ content: '', reasoning_content: '', tool_calls: [] }),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ],
    })
    const frames = await streamFrames(await login())
    const deltas = chunkDeltas(frames)
    // exactly one real content delta; the two empty envelopes must vanish
    expect(deltas.filter((d) => typeof d.text === 'string' && d.text !== '')).toHaveLength(1)
    expect(deltas).toHaveLength(1)
  })
})
