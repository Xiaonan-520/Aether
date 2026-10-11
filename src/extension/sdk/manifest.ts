/**
 * Extension SDK — manifest shape + boot-time structural validation. The full
 * cross-field rules live in the Manager's install-time validation; this
 * catch-fails-fast variant guards an extension against starting with a
 * manifest that cannot possibly pass.
 */

export interface SdkActionDescriptor {
  id: string
  title?: string
  description?: string
  /** http verb the core must use when proxying (default POST) */
  httpMethod?: string
  /** 'readonly' actions are safe to retry; 'mutating' are not */
  sideEffects?: 'readonly' | 'mutating'
  ui?: 'none' | 'basic' | 'page'
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  [key: string]: unknown
}

export interface SdkProviderDescriptor {
  id: string
  displayName?: string
  upstreamModel?: string
  loginMode?: string
  needsCaptcha?: boolean
  authAction?: SdkActionDescriptor
  actions?: SdkActionDescriptor[]
  models?: Array<{ id: string; displayName?: string; contextWindow?: number; [key: string]: unknown }>
  [key: string]: unknown
}

export interface SdkExtensionManifest {
  protocol: string
  extension: { id: string; name: string; version: string; [key: string]: unknown }
  runtime: { image: { repo: string; tag: string; digest?: string }; port: number; healthPath?: string; [key: string]: unknown }
  providers: SdkProviderDescriptor[]
  [key: string]: unknown
}

export const MANIFEST_ROUTES = ['manifest', 'health'] as const

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.-]+)?$/

/** throw-helper: a module-level function declaration so TS narrows `unknown`
 * after the guard (const arrow with `never` return does not narrow here). */
function bail(path: string, message: string): never {
  throw errors.protocolViolation(`${path}: ${message}`)
}

export interface ManifestViolation {
  path: string
  message: string
}

/** Boot-time structural check: throws a PROTOCOL_VIOLATION on the first problem. */
export function validateManifestShape(manifest: unknown): SdkExtensionManifest {
  if (typeof manifest !== 'object' || manifest === null) bail('', 'manifest must be a JSON object')
  const m = manifest as Record<string, unknown>

  if (m.protocol !== 'v1') bail('protocol', 'only protocol "v1" is supported')
  const ext = m.extension as Record<string, unknown> | undefined
  if (typeof ext !== 'object' || ext === null) bail('extension', 'required')
  const extId = ext!.id
  const extVersion = ext!.version
  if (typeof extId !== 'string' || !ID_RE.test(extId)) bail('extension.id', 'must match [a-z0-9][a-z0-9-]{0,63}')
  if (typeof extVersion !== 'string' || !VERSION_RE.test(extVersion)) bail('extension.version', 'must be semver-ish (x.y.z)')
  if (typeof ext!.name !== 'string' || (ext!.name as string).length === 0) bail('extension.name', 'required')

  const runtime = m.runtime as Record<string, unknown> | undefined
  if (typeof runtime !== 'object' || runtime === null) bail('runtime', 'required')
  const image = runtime!.image as Record<string, unknown> | undefined
  if (typeof image !== 'object' || image === null) bail('runtime.image', 'required')
  if (typeof image!.repo !== 'string' || image!.repo.length === 0) bail('runtime.image.repo', 'required')
  if (typeof image!.tag !== 'string' || image!.tag.length === 0) bail('runtime.image.tag', 'required')
  if (typeof runtime!.port !== 'number' || runtime!.port <= 0 || runtime!.port > 65535) bail('runtime.port', 'must be 1-65535')

  if (!Array.isArray(m.providers) || m.providers.length === 0) bail('providers', 'at least one provider is required')
  const seenProviders = new Set<string>()
  const seenActions = new Set<string>()
  for (const [i, p] of (m.providers as unknown[]).entries()) {
    if (typeof p !== 'object' || p === null) bail(`providers.${i}`, 'must be an object')
    const pd = p as Record<string, unknown>
    const pid: unknown = pd.id
    if (typeof pid !== 'string') bail(`providers.${i}.id`, 'must match [a-z0-9][a-z0-9-]{0,63}')
    if (!ID_RE.test(pid)) bail(`providers.${i}.id`, 'must match [a-z0-9][a-z0-9-]{0,63}')
    if (seenProviders.has(pid)) bail(`providers.${i}.id`, `duplicate provider id "${pid}"`)
    seenProviders.add(pid)
    for (const a of (pd.actions as unknown[] | undefined) ?? []) {
      if (typeof a !== 'object' || a === null) bail(`providers.${i}.actions`, 'must be objects')
      const ad = a as Record<string, unknown>
      const aid: unknown = ad.id
      if (typeof aid !== 'string') bail(`providers.${i}.actions.id`, 'must match [a-z0-9][a-z0-9-]{0,63}')
      if (!ID_RE.test(aid)) bail(`providers.${i}.actions.id`, 'must match [a-z0-9][a-z0-9-]{0,63}')
      const key = `${pid}:${aid}`
      if (seenActions.has(key)) bail(`providers.${i}.actions`, `duplicate action "${aid}" in provider "${pid}"`)
      seenActions.add(key)
    }
  }
  return manifest as SdkExtensionManifest
}

/** Action ids declared across all providers — the /v1/actions whitelist source. */
export function declaredActionIds(manifest: SdkExtensionManifest): string[] {
  const ids: string[] = []
  for (const p of manifest.providers) {
    for (const a of p.actions ?? []) ids.push(a.id)
  }
  return ids
}

// local import shim to avoid a circular top-level import in errors.ts
import { errors } from './errors.js'
