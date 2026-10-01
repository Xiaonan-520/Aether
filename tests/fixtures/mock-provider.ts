/**
 * Scriptable mock provider for tests: implements the full Provider interface
 * and replays a programmed sequence of outcomes (chunks or errors) per call.
 * Never contacts a real upstream.
 */
import type {
  Account,
  ClaimOutcome,
  ChatChunk,
  ChatRequest,
  ChatResult,
  ModelEntry,
  ProviderCapabilities,
  QuotaSnapshot,
  Tool,
} from '../../src/core/types.js'
import type {
  BeginLoginInput,
  BeginLoginResult,
  CredentialHandle,
  PollLoginResult,
  Provider,
  ProviderCtx,
  RefreshResult,
} from '../../src/core/registry/provider.js'
import { UpstreamError } from '../../src/core/errors/upstream-error.js'

export type ScriptedOutcome =
  | { type: 'chunks'; chunks: ChatChunk[] }
  | { type: 'result'; result: ChatResult }
  | { type: 'error'; error: UpstreamError }

export interface MockProviderOptions {
  id?: string
  capabilities?: Partial<ProviderCapabilities>
  models?: ModelEntry[]
  /** outcomes consumed in order per chat call; last one repeats */
  chatScript?: ScriptedOutcome[]
  refresh?: (account: Account) => Promise<RefreshResult>
  quota?: (account: Account) => Promise<QuotaSnapshot>
  claim?: (account: Account) => Promise<ClaimOutcome>
}

export function mockCapabilities(
  overrides: Partial<ProviderCapabilities> = {},
): ProviderCapabilities {
  return {
    supportsOAuth: true,
    supportsRefreshToken: true,
    supportsQuota: true,
    supportsCredits: false,
    supportsStreaming: true,
    supportsVision: false,
    supportsToolCall: false,
    supportsMultipleAccounts: true,
    needsCaptcha: false,
    loginMode: 'oauth',
    protocol: 'openai-chat',
    ...overrides,
  }
}

export function mockModels(provider: string): ModelEntry[] {
  return [
    {
      modelId: 'mock-model',
      provider,
      upstreamModel: 'mock-model',
      name: 'Mock Model',
      capabilities: { vision: false, toolCall: false, streaming: true },
      enabled: true,
      priority: 10,
      metadataJson: null,
    },
  ]
}

export class MockProvider implements Provider {
  readonly id: string
  readonly displayName: string
  readonly capabilities: ProviderCapabilities
  readonly models: ModelEntry[]
  chatScript: ScriptedOutcome[]
  chatCalls: Array<{ req: ChatRequest; accountId: string }> = []
  refreshFn?: MockProviderOptions['refresh']
  quotaFn?: MockProviderOptions['quota']
  claimFn?: MockProviderOptions['claim']

  constructor(opts: MockProviderOptions = {}) {
    this.id = opts.id ?? 'mock'
    this.displayName = opts.id ?? 'mock'
    this.capabilities = mockCapabilities(opts.capabilities)
    this.models = opts.models ?? mockModels(this.id)
    this.chatScript = opts.chatScript ?? [
      { type: 'result', result: { content: 'mock reply', finishReason: 'stop' } },
    ]
    this.refreshFn = opts.refresh
    this.quotaFn = opts.quota
    this.claimFn = opts.claim
  }

  private nextOutcome(): ScriptedOutcome {
    const next = this.chatScript.shift()
    return next ?? this.chatScript[this.chatScript.length - 1]
  }

  readonly auth = {
    beginLogin: async (_input: BeginLoginInput): Promise<BeginLoginResult> => ({
      loginUrl: 'https://example.com/login',
      expiresIn: 300,
      pollInterval: 1,
    }),
    pollLogin: async (): Promise<PollLoginResult> => ({ done: false }),
  }

  readonly ops = {
    refreshAccount: async (account: Account): Promise<RefreshResult> => {
      if (this.refreshFn) return this.refreshFn(account)
      return { refreshable: true, expiresAt: Date.now() + 3_600_000, refreshed: true }
    },
    getQuota: async (account: Account): Promise<QuotaSnapshot> => {
      if (this.quotaFn) return this.quotaFn(account)
      return { known: true, remaining: 100, total: 200, resetAt: null, lastUpdatedAt: Date.now(), rawJson: null }
    },
    claimCredits: async (account: Account): Promise<ClaimOutcome> => {
      if (this.claimFn) return this.claimFn(account)
      return { kind: 'unsupported' }
    },
    healthCheck: async () => ({ ok: true }),
  }

  readonly chat = {
    listModels: async (_ctx: ProviderCtx): Promise<ModelEntry[]> => this.models,
    chat: async (
      _ctx: ProviderCtx,
      req: ChatRequest,
      account: Account,
      _tools?: Tool[],
    ): Promise<ChatResult> => {
      this.chatCalls.push({ req, accountId: account.id })
      const outcome = this.nextOutcome()
      if (outcome.type === 'error') throw outcome.error
      if (outcome.type === 'result') return outcome.result
      // aggregate chunks
      let content = ''
      let finishReason: string | null = null
      for (const chunk of outcome.chunks) {
        content += chunk.text
        if (chunk.finishReason) finishReason = chunk.finishReason
      }
      return { content, finishReason: finishReason ?? 'stop' }
    },
    stream: async function* (
      this: MockProvider,
      _ctx: ProviderCtx,
      req: ChatRequest,
      account: Account,
      _tools?: Tool[],
    ): AsyncGenerator<ChatChunk> {
      this.chatCalls.push({ req, accountId: account.id })
      const outcome = this.nextOutcome()
      if (outcome.type === 'error') throw outcome.error
      if (outcome.type === 'result') {
        yield { text: outcome.result.content, finishReason: outcome.result.finishReason as ChatChunk['finishReason'], usage: outcome.result.usage ? { promptTokens: outcome.result.usage.promptTokens, completionTokens: outcome.result.usage.completionTokens } : undefined }
        return
      }
      for (const chunk of outcome.chunks) yield chunk
      // a scripted error following the chunks fires after they are consumed
      const next = this.chatScript[0]
      if (next?.type === 'error') {
        this.chatScript.shift()
        throw next.error
      }
    }.bind(this),
  }

  /** ctx factory matching what the service layer will provide */
  static ctx(resolveCredential: (account: Account) => Promise<CredentialHandle | undefined>): ProviderCtx {
    return { provider: 'mock', resolveCredential }
  }
}
