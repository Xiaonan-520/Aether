/**
 * Service context: the dependency bundle built once at bootstrap and shared by
 * all services. Core logic depends on this interface, not on concrete stores.
 */
import type { Account } from '../core/types.js'
import type { CredentialCipher } from '../store/crypto.js'
import type { ProviderRegistry } from '../core/registry/provider-registry.js'
import type { ModelRouter } from '../core/router/model-router.js'
import type { AccountPool } from '../core/pool/account-pool.js'
import type { StoreGateway } from '../store/types.js'
import type { GatewayConfig } from '../config/index.js'
import type { ZCodeCaptchaManager } from '../providers/zcode/captcha.js'

export interface ServiceContext {
  config: GatewayConfig
  store: StoreGateway
  cipher: CredentialCipher
  registry: ProviderRegistry
  router: ModelRouter
  pool: AccountPool
  /** shared ZCode captcha token cache (manual submission only) */
  captcha: ZCodeCaptchaManager
  now: () => number
}

/** Decrypt a stored credential for an account. Throws on missing/corrupt. */
export function resolveCredentialJson<T>(
  ctx: ServiceContext,
  account: Account,
): T | undefined {
  const stored = ctx.store.getAccount(account.id)
  if (!stored?.credential) return undefined
  try {
    return ctx.cipher.decryptJson<T>(stored.credential)
  } catch {
    return undefined
  }
}

/** Encrypt and persist a credential for an account's credentialKey. */
export function storeCredentialJson(
  ctx: ServiceContext,
  account: Account,
  credential: unknown,
): void {
  ctx.store.setCredential(account.credentialKey, ctx.cipher.encryptJson(credential))
}
