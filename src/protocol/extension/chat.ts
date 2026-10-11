/**
 * Chat contract for the Extension Protocol (RFC v2 §11).
 *
 * Layering (RFC v2 §11):
 *
 *   Client API (OpenAI-compatible JSON/SSE)
 *        ↓  src/protocol/openai/         ← existing translate layer, untouched
 *   Core internal contract (ChatRequest/ChatChunk/ChatResult)
 *        ↓  THIS FILE                    ← the protocol boundary
 *   Extension Protocol (HTTP+JSON+SSE)
 *
 * The extension protocol reuses Core's canonical chat shapes instead of
 * binding to the whole OpenAI API: the extension receives already-routed,
 * already-prefixed requests addressed to one account, and answers with
 * canonical chunks or a structured error. `provider::` prefixes are stripped
 * by Core before the request leaves (the extension's provider identity comes
 * from its manifest, not from the URL).
 */

import type { ChatRequest, ChatResult, ChatChunk } from '../../core/types.js'
import type { AccountId, ModelId } from './namespace.js'
import type { ExtensionErrorBody } from './errors.js'

/** POST /v1/chat request body. `stream` selects JSON vs SSE response. */
export interface ExtensionChatRequest extends ChatRequest {
  /** the account Core's pool selected — extensions never choose accounts */
  accountId: AccountId
  /** model id WITHOUT the `providerId::` prefix (routed by Core) */
  model: ModelId
  /** end-to-end trace id (X-Request-Id) */
  requestId: string
  /** wall-clock budget for the whole exchange; extension must respect it */
  deadlineMs: number
}

/** Non-streaming response (stream=false). */
export interface ExtensionChatResult extends ChatResult {}

/**
 * Streaming transport (stream=true): `200 text/event-stream`.
 *
 * Frames:
 *   event: chunk   data: {"type":"content", ...}      — canonical ChatChunk
 *   event: done    data: {"finish_reason": "...", "usage": {...}} — terminal success
 *   event: error   data: ExtensionErrorBody           — terminal failure
 *
 * Exactly one terminal frame (done|error) is emitted. Client disconnects
 * propagate as stream cancellation — the extension must close its upstream.
 */
export type ExtensionStreamEvent =
  | { event: 'chunk'; data: ChatChunk }
  | { event: 'done'; data: { finishReason: string; usage?: ChatResult['usage'] } }
  | { event: 'error'; data: ExtensionErrorBody }
