/**
 * ZCode ExtensionManifest（Extension Protocol v1）。
 *
 * 与 workbuddycn 的差异：
 *  - needsCaptcha: true（zcode 上游有条件挑战）；登录模式是两段式 oauth；
 *  - 额度契约声明 tokens 资源（coding-plan 请求额度）；
 *  - quotaResources.fields 声明 remaining/total/resetAt —— 上游缺失时
 *    扩展保持 null，Core 不伪造 0。
 */
import type { ExtensionManifest } from './types.js'
import { ZCODE_MODELS } from '../provider/zcode/catalog.js'

export const EXTENSION_VERSION = '1.0.0'

export const MANIFEST: ExtensionManifest = {
  apiVersion: '1.0',
  extension: {
    id: 'zcode',
    version: EXTENSION_VERSION,
    displayName: 'ZCode (Z.AI)',
    description: 'ZCode coding-plan (Z.AI) provider extension — Anthropic Messages upstream, manual captcha handoff',
    license: 'MIT',
  },
  runtime: {
    port: 8080,
    healthPath: '/health',
    env: [
      { name: 'LOG_LEVEL', required: false, default: 'info' },
      { name: 'ZCODE_CAPTCHA_WAIT_MS', required: false, default: '60000' },
    ],
    volumes: [{ name: 'state', mountPath: '/data', purpose: 'encrypted credentials + login sessions' }],
    resources: { memory: '256Mi', cpus: '0.5' },
  },
  security: {
    permissions: {
      network: { domains: ['zcode.z.ai', 'api.z.ai', 'o.alicdn.com'] },
      filesystem: 'named-volumes-only',
      capabilities: [],
      privileged: false,
    },
  },
  providers: [
    {
      id: 'zcode',
      displayName: 'ZCode (Z.AI)',
      protocol: 'anthropic-messages',
      quotaResources: [
        {
          id: 'coding-plan',
          kind: 'tokens',
          unit: 'requests',
          displayName: 'Coding plan usage',
          fields: { remaining: true, total: true, resetAt: true },
        },
      ],
      capabilities: {
        supportsOAuth: true,
        supportsRefreshToken: false,
        supportsQuota: true,
        supportsCredits: false,
        supportsStreaming: true,
        supportsVision: false,
        supportsToolCall: true,
        supportsMultipleAccounts: true,
        needsCaptcha: true,
        loginMode: 'oauth',
        protocol: 'anthropic-messages',
      },
      fallbackModels: ZCODE_MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        capabilities: { vision: false, toolCall: true, streaming: true },
      })),
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
        },
        {
          // 人工验证码提交通道（协议要求的 write action）。
          // 实现端点是 POST /v1/captcha；actionId 走通用 /v1/actions 分发。
          id: 'submit-captcha',
          httpMethod: 'POST',
          title: 'Submit captcha token',
          mode: 'write',
          sideEffects: 'one-shot',
          ui: 'browser',
          inputSchema: {
            type: 'object',
            required: ['verify_param'],
            properties: {
              verify_param: { type: 'string', description: 'Aliyun captcha verify param from the human-completed widget.' },
            },
          },
          outputSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
          },
        },
      ],
    },
  ],
}
