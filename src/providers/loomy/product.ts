/**
 * Loomy (讯飞办公助手) product configuration.
 * Verified values (jet-hub src/loomy-product.ts).
 */
export interface LoomyProduct {
  id: 'loomy'
  displayName: string
  apiBase: string
  accountBase: string
  accessKeyId: string
  accessKeySecret: string
  userAgent: string
  fallbackModels: ReadonlyArray<{ id: string; name: string }>
}

/**
 * Account-endpoint signing key pair.
 *
 * The reference ships a fixed client key pair because the official client
 * identifies itself with it. It is a client credential, not a user secret: the
 * user credential is the `session` obtained at login.
 */
export const LOOMY_ACCESS_KEY_ID = 'loomy-client'
export const LOOMY_ACCESS_KEY_SECRET = 'loomy-client-secret'

export const LOOMY: LoomyProduct = {
  id: 'loomy',
  displayName: 'Loomy (讯飞)',
  apiBase: 'https://loomyad.xunfei.cn/api/v1',
  accountBase: 'https://account.xfinfr.com',
  accessKeyId: LOOMY_ACCESS_KEY_ID,
  accessKeySecret: LOOMY_ACCESS_KEY_SECRET,
  userAgent: 'Loomy/1.0',
  fallbackModels: [
    { id: 'minimax-m3', name: 'MiniMax M3' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  ],
}

export const LOOMY_MODELS_PATH = '/models'
export const LOOMY_CHAT_PATH = '/chat/completions'
export const LOOMY_POINTS_RECORDS_PATH = '/points/records'
export const LOOMY_FIRST_LOGIN_PATH = '/points/first-login'
export const LOOMY_SEND_CODE_PATH = '/login/phone/sendMsgCode'
export const LOOMY_CHECK_CODE_PATH = '/login/phone/checkCode'
