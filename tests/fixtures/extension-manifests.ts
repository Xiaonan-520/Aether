/**
 * Conformance fixtures (RFC v2 §22.1): a minimal valid manifest and the
 * canonical zcode captcha action pair used by contract tests across phases.
 * These are TEST FIXTURES — declared intents, not running extensions.
 */
import type { ExtensionManifest } from '../../src/protocol/extension/index.js'

/** RFC §12 / §16.4 canonical example: zcode with human-completed captcha. */
export const zcodeManifestFixture: ExtensionManifest = {
  apiVersion: '1.0',
  extension: {
    id: 'zcode',
    version: '1.2.0',
    displayName: 'ZCode Provider',
    description: 'ZCode (z.ai) provider with human-completed captcha flow',
    author: 'xiaonan-520',
    license: 'MIT',
  },
  distribution: {
    image: 'ghcr.io/xiaonan-520/gateway-extension-zcode',
    tag: '1.2.0',
  },
  runtime: {
    port: 8080,
    healthPath: '/health',
    env: [{ name: 'LOG_LEVEL', required: false, default: 'info' }],
    volumes: [{ name: 'zcode-state', mountPath: '/data', purpose: 'credentials + flow state' }],
    resources: { memory: '256Mi', cpus: '0.5' },
  },
  security: {
    permissions: {
      network: { domains: ['zcode.z.ai', 'chatglm.cn'] },
      filesystem: 'named-volumes-only',
      capabilities: [],
      privileged: false,
    },
  },
  providers: [
    {
      id: 'zcode',
      displayName: 'ZCode',
      protocol: 'anthropic-messages',
      capabilities: {
        supportsOAuth: true,
        supportsRefreshToken: true,
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
      fallbackModels: [{ id: 'glm-4.7', name: 'GLM-4.7', capabilities: { toolCall: true, streaming: true } }],
      actions: [
        {
          id: 'captcha-widget',
          httpMethod: 'GET',
          title: 'Open captcha',
          mode: 'read',
          sideEffects: 'none',
          ui: 'browser',
          outputSchema: { type: 'object', properties: { html: { type: 'string' } }, required: ['html'] },
        },
        {
          id: 'captcha-submit',
          httpMethod: 'POST',
          title: 'Submit captcha',
          mode: 'write',
          sideEffects: 'one-shot',
          ui: 'form',
          inputSchema: { type: 'object', properties: { verify_param: { type: 'string' } }, required: ['verify_param'] },
          outputSchema: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'] },
        },
      ],
    },
  ],
}

/** RFC §12 full example: buddy — one extension carrying four providers. */
export const buddyManifestFixture: ExtensionManifest = {
  apiVersion: '1.0',
  extension: { id: 'buddy', version: '1.0.0', displayName: 'Buddy Family' },
  runtime: { port: 8080, healthPath: '/health' },
  providers: (
    [
      ['workbuddy', false],
      ['workbuddy-cn', false],
      ['codebuddy', false],
      ['buddy-intl', false],
    ] as const
  ).map(([id]) => ({
    id,
    displayName: id,
    protocol: 'openai-chat',
    capabilities: {
      supportsOAuth: false,
      supportsRefreshToken: true,
      supportsQuota: true,
      supportsCredits: true,
      supportsStreaming: true,
      supportsVision: false,
      supportsToolCall: false,
      supportsMultipleAccounts: true,
      needsCaptcha: false,
      loginMode: 'disk-credential' as const,
      protocol: 'openai-chat' as const,
    },
    fallbackModels: [{ id: 'glm-4.7', name: 'GLM-4.7' }],
  })),
}

/** Scripted fake extension implementing the SuiteTransport surface. */
export const fakeExtensionTransport = (overrides: Partial<{ status: string; manifest: unknown }> = {}) => {
  const manifest = overrides.manifest ?? structuredClone(zcodeManifestFixture)
  return {
    manifest: async () => manifest,
    health: async () => ({ status: overrides.status ?? 'healthy' }),
  }
}
