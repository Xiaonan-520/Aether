/**
 * Action invocation contract (RFC v2 §16, §16.4).
 *
 * Actions are the NARROW interactive channel (captcha pages, sms codes,
 * credential setup) between a browser/admin and an extension. Core proxies
 * them opaquely: it enforces authentication, the manifest-declared whitelist,
 * size limits, Content-Type and timeout — and NEVER interprets the payload.
 * There is deliberately no "kind" discriminator here that could let Core
 * branch on provider specifics.
 *
 * Hard constraints (RFC v2 §16.4):
 *  - only manifest-declared actions are invocable (whitelist);
 *  - request/response must satisfy the declared JSON Schemas;
 *  - mode/sideEffects are declared so Core/Manager can classify risk;
 *  - forbidden by construction: command execution, eval, arbitrary subprocess,
 *    arbitrary proxying, Docker control, host control, filesystem escape.
 *    (Manifest declarations implying any of these fail manifest validation.)
 */

import type { AccountId } from './namespace.js'

/**
 * Invoke an action: `POST|GET /v1/actions/:actionId` on the extension, proxied
 * by Core as `/api/ext/:extensionId/providers/:providerId/actions/:actionId`.
 *
 * The payload is opaque to Core (JSON value). For credential-carrying actions
 * (e.g. `submit-credential`) this opacity is the credential boundary: the
 * plaintext lives only inside the request lifecycle, never in Core storage,
 * events or logs (§10.3).
 */
export interface InvokeActionRequest {
  actionId: string
  /** target account, when the action is account-scoped (captcha, sms, import) */
  accountId?: AccountId
  /** opaque JSON payload; validated against the declared inputSchema by the extension */
  payload?: unknown
}

export interface InvokeActionResponse {
  actionId: string
  /** opaque JSON result; validated against the declared outputSchema by the extension */
  result: unknown
}
