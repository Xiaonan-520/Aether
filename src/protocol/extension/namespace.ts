/**
 * Extension Protocol namespace contracts (RFC v2 §9.1).
 *
 * Four strictly separated identifiers. NEVER assume extensionId === providerId:
 * one extension (e.g. `buddy`) may carry several providers (`workbuddy`,
 * `workbuddy-cn`, `codebuddy`, `buddy-intl`).
 *
 * Visibility rules:
 *  - extensionId NEVER appears in the public OpenAI-compatible API; the client
 *    route key is `providerId::modelId`.
 *  - providerId NEVER appears inside Extension Protocol payloads sent to the
 *    extension: the container's manifest already defines which providers it
 *    serves, so payloads address accounts/models only.
 *  - accountId is a globally unique opaque identifier ALLOCATED BY CORE
 *    (suggested format `providerId-xxxx`, format is a convention not a
 *    contract). Extensions map accountId → their private upstream identity.
 */

/** Installation / container unit. `[a-z0-9-]+`, GHCR repo suffix `gateway-extension-<id>`. */
export type ExtensionId = string

/**
 * Protocol capability unit (`providers[]` entry). Globally unique across the
 * deployment — two extensions may not declare the same providerId.
 */
export type ProviderId = string

/** Globally unique opaque account identifier, allocated by Core. */
export type AccountId = string

/** Model id inside one provider's namespace (WITHOUT the `providerId::` prefix). */
export type ModelId = string

// ---------------------------------------------------------------------------
// Validation helpers (pure functions; no zod dependency for identifiers)
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Validate an extension/provider identifier: `[a-z0-9-]+`, lowercase, ≤64 chars. */
export function isValidIdentifier(id: string): boolean {
  return ID_PATTERN.test(id)
}

/** Build the public OpenAI-compatible route key. */
export function toPublicModelKey(providerId: ProviderId, modelId: ModelId): string {
  return `${providerId}::${modelId}`
}

/**
 * Split a public model key. Returns null when the key carries no provider
 * prefix (the caller then resolves the provider by routing priority).
 */
export function splitPublicModelKey(key: string): { providerId: ProviderId; modelId: ModelId } | null {
  const sep = key.indexOf('::')
  if (sep <= 0) return null
  return { providerId: key.slice(0, sep), modelId: key.slice(sep + 2) }
}
