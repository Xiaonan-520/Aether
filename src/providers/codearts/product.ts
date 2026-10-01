/**
 * CodeArts (华为云码道) product configuration.
 *
 * Verified endpoints (jet-hub src/llm-adapter.ts, src/models.ts,
 * src/codearts-credits.ts; reverse-engineered from the installed IDE, not
 * guessed — the official portal paths are BFF/browser-cookie only and do not
 * work with AK/SK signing):
 *
 * | purpose       | method | path                                        |
 * |---------------|--------|---------------------------------------------|
 * | chat          | POST   | {snapBase}/api/v2/chat/completions          |
 * | models        | GET    | {snapBase}/v1/model/builtin                 |
 * | package info  | GET    | {snapBase}/snap-manager/v1/statistics/plugin|
 * | activities    | GET    | {snapBase}/v1/ops/delivery?channel=IDE      |
 * | claim         | POST   | {snapBase}/v1/ops/claim                     |
 * | claim confirm | POST   | {snapBase}/v1/ops/confirm                   |
 *
 * All snap-manager/ops/model endpoints are signed with SDK-HMAC-SHA256.
 */
export interface CodeArtsProduct {
  id: 'codearts'
  displayName: string
  snapBase: string
  chatBase: string
  consoleBase: string
  gatewayConfigUrl: string
  /** extra signed header required for server-side routing */
  agentTypeHeader: string
  userAgent: string
  fallbackModels: ReadonlyArray<{ id: string; name: string }>
}

export const CODEARTS: CodeArtsProduct = {
  id: 'codearts',
  displayName: 'CodeArts (华为云)',
  snapBase: 'https://snap-access.cn-north-4.myhuaweicloud.com',
  chatBase: 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2',
  consoleBase: 'https://codearts.huaweicloud.com',
  gatewayConfigUrl: 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config',
  agentTypeHeader: 'PromptCenter',
  userAgent: 'CodeArtsAgent/1.0',
  fallbackModels: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
  ],
}

export const CODEARTS_SNAP_MODEL_BUILTIN_PATH = '/v1/model/builtin'
export const CODEARTS_CHAT_PATH = '/chat/completions'
export const CODEARTS_PACKAGE_INFO_PATH = '/snap-manager/v1/statistics/plugin'
export const CODEARTS_OPS_DELIVERY_PATH = '/v1/ops/delivery'
export const CODEARTS_OPS_CLAIM_PATH = '/v1/ops/claim'
export const CODEARTS_OPS_CONFIRM_PATH = '/v1/ops/confirm'
