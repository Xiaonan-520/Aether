/**
 * ARCHIVED from tests/audit-regressions.spec.ts when the built-in ZCode
 * adapter migrated to extensions/zcode. The pinned regressions (stream-reader
 * finally-cancel, Anthropic error-event propagation, malformed-JSON →
 * EMPTY_RESPONSE) are behavioural guarantees of the provider implementation —
 * the extension chat suite (extensions/zcode) covers the same upstream
 * behaviours through the protocol surface. Kept verbatim for reference.
 */
describe('audit regression — zcode stream reader cleanup', () => {
  it('cancels the upstream reader when the consumer breaks out early', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('v')
    // a never-ending SSE body: without finally-cancel this fetcher's body
    // stays locked after the consumer stops
    const sse = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"He"}}\n\n'
    const fetcher = fetcherFor([{ match: 'anthropic/v1/messages', text: sse }])
    const provider = createZCodeProvider({ captcha, fetcher })
    const req: ChatRequest = { model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], stream: true }

    for await (const chunk of provider.chat.stream(zcodeCtx({ jwt_token: 'jwt' }), req, account({ provider: 'zcode' }))) {
      void chunk
      break // consumer stops after the first chunk (client disconnect pattern)
    }
    // the underlying body must be released — a second reader would throw
    // if the stream were still locked
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('releases the body on mid-stream failure', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('v')
    const sse = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"He"}}',
      '',
      'data: {"type":"error","error":{"type":"overloaded","message":"boomed"}}',
      '',
    ].join('\n')
    const provider = createZCodeProvider({ captcha, fetcher: fetcherFor([{ match: 'anthropic/v1/messages', text: sse }]) })
    const req: ChatRequest = { model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], stream: true }
    await expect((async () => {
      for await (const chunk of provider.chat.stream(zcodeCtx({ jwt_token: 'jwt' }), req, account({ provider: 'zcode' }))) {
        void chunk
      }
    })()).rejects.toMatchObject({ kind: 'UPSTREAM_5XX' })
  })
})

describe('audit regression — zcode stream error events (truncation fix)', () => {
  it('maps an Anthropic error event onto UPSTREAM_5XX instead of a clean stop', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('v')
    const sse = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"He"}}',
      '',
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      '',
    ].join('\n')
    const provider = createZCodeProvider({ captcha, fetcher: fetcherFor([{ match: 'anthropic/v1/messages', text: sse }]) })
    const req: ChatRequest = { model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], stream: true }
    const chunks: unknown[] = []
    await expect((async () => {
      for await (const chunk of provider.chat.stream(zcodeCtx({ jwt_token: 'jwt' }), req, account({ provider: 'zcode' }))) {
        chunks.push(chunk)
      }
    })()).rejects.toMatchObject({ kind: 'UPSTREAM_5XX', message: expect.stringContaining('Overloaded') })
    // the partial text before the error still made it out
    expect(chunks.length).toBe(1)
  })

  it('non-streaming: malformed JSON maps to EMPTY_RESPONSE, not SyntaxError', async () => {
    const captcha = new ZCodeCaptchaManager()
    captcha.submit('v')
    const provider = createZCodeProvider({
      captcha,
      fetcher: fetcherFor([{ match: 'anthropic/v1/messages', status: 200, text: '<html>gateway boom</html>' }]),
    })
    await expect(
      provider.chat.chat(zcodeCtx({ jwt_token: 'jwt' }), { model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], stream: false }, account({ provider: 'zcode' })),
    ).rejects.toMatchObject({ kind: 'EMPTY_RESPONSE' })
  })
})

describe('audit regression — buddy stream reader cleanup', () => {
  it('releases the upstream body via finally on the non-stream aggregation path', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"He"}}]}',
      '',
      'data: {"choices":[{"delta":{}],"finish_reason":null}]}', // malformed shape → skipped
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetcher = fetcherFor([{ match: '/v2/chat/completions', text: sse }])
    const provider = createWorkBuddyProvider(fetcher)
    const result = await provider.chat.chat(
      buddyCtx(),
      { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: false },
      account({ provider: 'workbuddy' }),
    )
    expect(result.content).toBe('He')
  })
})

const CREDENTIAL = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  user_id: 'u1',
  domain: 'www.workbuddy.ai',
}

function buddyCtx(): ProviderCtx {
  return {
    provider: 'workbuddy',
    resolveCredential: async () => ({ ref: 'CRED', expiresAt: null, refreshable: true, credential: CREDENTIAL }),
  }
}
