/**
 * The WorkBuddyCN ExtensionManifest, conforming to the Phase 3 protocol schema
 * (validate-manifest.ts). Validated locally by src/protocol/validate-manifest.ts
 * and by the Gateway at install time.
 *
 * Notes:
 *  - `loginMode: 'external-link'` — login returns the official CodeBuddy China
 *    login page URL; the extension polls the upstream. No credential entry action
 *    is required, so `authAction` is intentionally absent.
 *  - `needsCaptcha: false` — WorkBuddyCN login has no captcha step; if the official
 *    page ever presents one, the human completes it there (the extension never
 *    solves or bypasses captchas).
 */
import type { ExtensionManifest } from './types.js'
import { EXTENSION_ID, PROVIDER_ID, PROTOCOL_VERSION } from './types.js'

// Keep in sync with package.json "version" — enforced by test/unit/manifest.spec.ts.
// History: 1.0.0 shipped as image tag 1.0.0; the 1.0.1 image (claim route) failed
// to bump this field, so Manager records showed version=1.0.0 / imageTag=1.0.1.
// 1.0.3: M0 E2E version-migration rehearsal (no functional change).
// 1.0.4: tool-call compat fixes — canonical toolCalls/toolCallId accepted from
// Core (camelCase), orphan tool results downgraded to user notes, sanitized
// upstream 400 diagnostics surfaced in error messages/logs.
// 1.0.5/1.0.6: canonical->OpenAI wire mapping + tool pairing defence (11148).
// 1.0.7: normalize the confirmed git-context label in system/assistant text
//        so ZCode-style prompts stop tripping the channel check (11128).
// 1.0.8: drop empty delta increments. The upstream sends a fixed delta envelope
//        (content/reasoning_content/refusal/tool_calls/...) where most fields
//        are empty; emitting "" / [] as real increments produced up to three
//        downstream frames per token (67% empty shells).
export const EXTENSION_VERSION = '1.0.8'

/** Fallback catalog (mirrors the upstream `buddy` CN static list). Live discovery wins. */
const FALLBACK_MODELS: ReadonlyArray<{
  id: string
  name: string
  capabilities: { vision: boolean; toolCall: boolean; streaming: boolean; reasoningEfforts?: string[] }
}> = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', capabilities: { vision: true, toolCall: true, streaming: true, reasoningEfforts: ['low', 'high', 'max'] } },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', capabilities: { vision: true, toolCall: true, streaming: true, reasoningEfforts: ['low', 'high', 'xhigh'] } },
  { id: 'hy4-preview', name: 'Hy4 Preview', capabilities: { vision: true, toolCall: true, streaming: true, reasoningEfforts: ['high'] } },
  { id: 'hy4-preview-x', name: 'Hy4 Preview X', capabilities: { vision: true, toolCall: true, streaming: true, reasoningEfforts: ['high'] } },
  { id: 'hy3', name: 'Hy3', capabilities: { vision: true, toolCall: true, streaming: true, reasoningEfforts: ['low', 'high'] } },
  { id: 'hy3-x', name: 'Hy3 X', capabilities: { vision: true, toolCall: true, streaming: true, reasoningEfforts: ['low', 'high'] } },
  { id: 'glm-5.3', name: 'GLM-5.3', capabilities: { vision: true, toolCall: true, streaming: true, reasoningEfforts: ['low', 'high', 'max'] } },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', capabilities: { vision: true, toolCall: true, streaming: true, reasoningEfforts: ['low', 'high', 'max'] } },
  { id: 'glm-5.2', name: 'GLM-5.2', capabilities: { vision: true, toolCall: true, streaming: true, reasoningEfforts: ['high', 'xhigh'] } },
  { id: 'glm-5.1', name: 'GLM-5.1', capabilities: { vision: true, toolCall: true, streaming: true } },
  { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', capabilities: { vision: true, toolCall: true, streaming: true } },
  { id: 'kimi-k3-1', name: 'Kimi K3-1', capabilities: { vision: true, toolCall: true, streaming: true } },
  { id: 'kimi-k2.7', name: 'Kimi K2.7', capabilities: { vision: true, toolCall: true, streaming: true } },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', capabilities: { vision: true, toolCall: true, streaming: true } },
  { id: 'minimax-m3', name: 'MiniMax M3', capabilities: { vision: true, toolCall: true, streaming: true } },
]

export const MANIFEST: ExtensionManifest = {
  apiVersion: PROTOCOL_VERSION,
  extension: {
    id: EXTENSION_ID,
    version: EXTENSION_VERSION,
    displayName: 'WorkBuddyCN',
    description: 'Tencent CodeBuddy / WorkBuddy China mainland provider extension',
    license: 'MIT',
  },
  runtime: {
    port: 8080,
    healthPath: '/health',
    env: [
      { name: 'LOG_LEVEL', required: false, default: 'info' },
      { name: 'WORKBUDDYCN_ENDPOINT', required: false, default: 'https://copilot.tencent.com' },
    ],
    volumes: [
      { name: 'state', mountPath: '/data', purpose: 'encrypted credentials + login sessions' },
    ],
    resources: { memory: '256Mi', cpus: '0.5' },
  },
  security: {
    permissions: {
      network: { domains: ['copilot.tencent.com', 'www.codebuddy.cn'] },
      filesystem: 'named-volumes-only',
      capabilities: [],
      privileged: false,
    },
  },
  providers: [
    {
      id: PROVIDER_ID,
      displayName: 'WorkBuddy China',
      protocol: 'openai-chat',
      quotaResources: [
        {
          id: 'credits',
          kind: 'credits',
          unit: 'credits',
          displayName: 'Bonus credits',
          fields: { remaining: true, total: true, resetAt: true },
        },
      ],
      capabilities: {
        supportsOAuth: true,
        supportsRefreshToken: true,
        supportsQuota: true,
        supportsCredits: true,
        supportsStreaming: true,
        supportsVision: true,
        supportsToolCall: true,
        supportsMultipleAccounts: true,
        needsCaptcha: false,
        loginMode: 'external-link',
        protocol: 'openai-chat',
      },
      fallbackModels: FALLBACK_MODELS.map((m) => ({ id: m.id, name: m.name, capabilities: { ...m.capabilities } })),
      // One genuine action: refresh the quota projection for an account. Read-only,
      // no side effects. The conformance gate requires a declared action, and this
      // one is real functionality (it re-reads the upstream credit balance).
      actions: [
        {
          id: 'refresh-quota',
          httpMethod: 'POST',
          title: 'Refresh quota',
          mode: 'read',
          sideEffects: 'none',
          ui: 'none',
          inputSchema: {
            type: 'object',
            properties: {
              account_id: { type: 'string', description: 'Opaque account id (optional; defaults to the first account).' },
            },
          },
          outputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              resources: { type: 'array' },
              checkedAt: { type: 'string' },
              source: { type: 'string' },
            },
          },
        },
      ],
    },
  ],
}

export function manifest(): ExtensionManifest {
  return MANIFEST
}

export { FALLBACK_MODELS }
