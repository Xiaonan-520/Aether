/**
 * Extension SDK — shared thin layer for Gateway extensions (docs/
 * EXTENSION_LIFECYCLE.md §9). In-repo shared code, NOT an npm package; the
 * files under `src/extension/sdk/` are self-contained (no imports from
 * `src/core` or `src/protocol`) so a standalone extension repo can copy them
 * verbatim.
 *
 * What it provides:
 *   - manifest shape + boot-time structural validation (types.ts, manifest.ts)
 *   - bearer-token auth middleware, timing-safe (auth.ts)
 *   - unified protocol error structure + HTTP helpers (errors.ts, http.ts)
 *   - route skeleton for the protocol endpoints incl. /health, /manifest,
 *     /v1/accounts*, /v1/models, /v1/chat (JSON + SSE), /v1/actions/:id
 *     whitelist (server.ts)
 *   - log-field sanitization (errors.ts)
 *
 * What it deliberately does NOT contain: any provider protocol, signing,
 * login flow, or credential handling — extensions implement the `adapter`
 * surface in server.ts.
 */

export {
  ExtensionProtocolError,
  errors,
  toExtensionError,
  isExtensionErrorBody,
  kindForUpstreamStatus,
  sanitizeLogFields,
  UPSTREAM_ERROR_KINDS,
} from './errors.js'
export type { ExtensionErrorKind, ExtensionErrorBody } from './errors.js'

export {
  ExtensionAuthError,
  bearerToken,
  checkExtensionAuth,
} from './auth.js'

export { parsePath, matchRoute, writeJson, readJsonObject } from './http.js'
export type { SdkRoute, SdkRequestContext } from './http.js'

export {
  validateManifestShape,
  declaredActionIds,
  MANIFEST_ROUTES,
} from './manifest.js'
export type {
  SdkExtensionManifest,
  SdkProviderDescriptor,
  SdkActionDescriptor,
} from './manifest.js'

export { createExtensionHttpServer, validateChatRequest, RequestRegistry } from './server.js'
export type { ExtensionSdkOptions, ExtensionAdapter, SdkChatRequest, SdkChatChunk } from './server.js'
