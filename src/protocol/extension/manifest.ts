/**
 * Extension Protocol v1 — shared wire types (RFC v2 §7, §22).
 *
 * These are the *protocol-level* contracts spoken between Gateway Core and a
 * remote extension over HTTP+JSON+SSE. They deliberately REUSE the internal
 * enums (`AccountStatus`, `UpstreamErrorKind`, `LoginMode`, …) instead of
 * duplicating them — Core's registry types and the protocol share one set of
 * semantic values, so no conversion boundary and no enum drift exists.
 *
 * Ownership invariants (RFC v2 §3.5 / §10.2 / §10.3):
 *  - credential plaintext, upstream account ids, OAuth sessions and raw quota
 *    NEVER appear in any type in this file — Core only ever sees normalized
 *    projections;
 *  - every payload is addressed by the opaque Core-allocated `account_id`.
 */

import type { AccountStatus, ProviderCapabilities } from '../../core/types.js'
import type { QuotaResourceDeclaration } from './accounts.js'
import type { UpstreamErrorKind } from '../../core/errors/upstream-error.js'
import type { AccountId, ExtensionId, ModelId, ProviderId } from './namespace.js'

/** Protocol version "MAJOR.MINOR". Core supports current and N-1 major. */
export type ProtocolVersion = `${number}.${number}`
export const PROTOCOL_VERSION = '1.0' as const

// ---------------------------------------------------------------------------
// Manifest (§12)
// ---------------------------------------------------------------------------

/**
 * Permitted network egress domains. DECLARATION ONLY (§12.2): in v1 this is
 * shown on the install dialog and written to the audit log; it does NOT
 * enforce any runtime isolation.
 */
export interface NetworkPermission {
  /** e.g. "zcode.z.ai" — intent declaration, audit-only in v1 */
  domains: string[]
}

export interface ExtensionPermissions {
  network?: NetworkPermission
  /** storage posture promise; Manager rejects anything else at install time */
  filesystem?: 'named-volumes-only'
  /** declared (audit-only in v1); Manager always drops ALL capabilities */
  capabilities?: string[]
  /** declared; Manager always creates non-privileged containers */
  privileged?: boolean
}

export interface ExtensionSecretDeclaration {
  name: string
  description?: string
  required: boolean
}

export interface ExtensionEnvEntry {
  name: string
  required: boolean
  default?: string
}

export interface ExtensionVolumeDeclaration {
  /** named volume, created/managed by the future Extension Manager */
  name: string
  mountPath: string
  /** human-readable purpose: "credentials + flow state" */
  purpose?: string
}

export interface ExtensionResources {
  memory?: string
  cpus?: string
}

export interface ExtensionRuntime {
  /** port the extension listens on inside its container */
  port: number
  /** liveness path, default "/health" */
  healthPath: string
  env?: ExtensionEnvEntry[]
  volumes?: ExtensionVolumeDeclaration[]
  resources?: ExtensionResources
}

export interface ExtensionDistribution {
  /** e.g. "ghcr.io/xiaonan-520/gateway-extension-zcode" */
  image: string
  /** semver tag; the Manager pins and records the resolved digest */
  tag: string
  /** optional digest pin (sha256:…) verified at install time */
  digest?: string
  /** GitHub release this manifest was published with */
  releaseUrl?: string
}

// ---------------------------------------------------------------------------
// Action declarations (§16.4) — narrow interactive channel, NOT arbitrary RPC
// ---------------------------------------------------------------------------

/** What an action does to extension-side state. */
export type ActionMode = 'read' | 'write' | 'flow-control'
export type ActionSideEffects = 'none' | 'idempotent' | 'one-shot'
/** Where the Core admin UI should render the interaction. */
export type ActionUi = 'form' | 'browser' | 'none'

export interface ActionDeclaration {
  /** stable id within the provider, e.g. "captcha-widget" */
  id: string
  httpMethod: 'GET' | 'POST'
  title: string
  mode: ActionMode
  sideEffects: ActionSideEffects
  ui: ActionUi
  /** JSON Schema for the request payload (must be {} for GET/read actions) */
  inputSchema?: Record<string, unknown>
  /** JSON Schema for the response payload */
  outputSchema?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Provider entry (§8, §12)
// ---------------------------------------------------------------------------

export interface ProviderModelDeclaration {
  id: ModelId
  name: string
  capabilities?: {
    vision?: boolean
    toolCall?: boolean
    streaming?: boolean
    reasoningEfforts?: string[]
  }
}

/** One provider served by this extension (an extension may declare many). */
export interface ProviderManifestEntry {
  id: ProviderId
  displayName: string
  protocol: 'openai-chat' | 'anthropic-messages' | string
  capabilities: ProviderCapabilities
  /**
   * Declarative quota contract (§13.1): which resources this provider reports
   * and their field semantics. Optional — a provider without quota support
   * omits it and Core shows "unknown"/"not supported" as appropriate. Core
   * validates live snapshots against this declaration (unknown resource ids
   * are surfaced, never silently rendered).
   */
  quotaResources?: QuotaResourceDeclaration[]
  /** static seed models merged into the Core model registry (§9) */
  fallbackModels?: ProviderModelDeclaration[]
  /** interactive actions exposed through the Core admin proxy (§16) */
  actions?: ActionDeclaration[]
  /**
   * The action that completes a login by submitting a credential/auth code
   * (RFC §10.3: credentials traverse ONLY this opaque action channel). Core
   * routes `auth.importCredential` payloads here; the structured seam itself
   * stays credential-free.
   */
  authAction?: string
  /** optional display hints for login forms; never credentials */
  accountFields?: Array<{ name: string; required: boolean; description?: string }>
}

// ---------------------------------------------------------------------------
// The manifest document
// ---------------------------------------------------------------------------

export interface ExtensionManifest {
  apiVersion: ProtocolVersion
  extension: {
    id: ExtensionId
    version: string
    displayName: string
    description?: string
    author?: string
    license?: string
    repository?: string
  }
  distribution?: ExtensionDistribution
  runtime: ExtensionRuntime
  security?: {
    permissions?: ExtensionPermissions
    secrets?: ExtensionSecretDeclaration[]
  }
  providers: ProviderManifestEntry[]
}
