/**
 * Local manifest validator — a faithful re-implementation of the Gateway's
 * validate-manifest.ts constraints, so the extension can self-check before an
 * install without importing Gateway source (no build/run dependency on it).
 *
 * Mirrors: schema shape (.strict()), security violations, cross-field rules.
 */
import type { ExtensionManifest } from './types.js'

export interface ManifestViolation {
  path: string
  message: string
}

export interface ManifestValidationResult {
  ok: boolean
  errors: ManifestViolation[]
  violations: ManifestViolation[]
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const PROTOCOL_RE = /^(\d+)\.(\d+)$/
const IDENT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/

const RESERVED_MOUNT_PATHS = new Set(['/var/run/docker.sock', '/var/run', '/proc', '/sys', '/dev'])
const LOGIN_MODES = ['oauth', 'device-code', 'external-link', 'sms', 'disk-credential', 'import']
const ACTIONS_MODES = ['read', 'write', 'flow-control']
const ACTIONS_SIDE_EFFECTS = ['none', 'idempotent', 'one-shot']
const ACTIONS_UI = ['form', 'browser', 'none']
const CAPABILITY_KEYS = [
  'supportsOAuth', 'supportsRefreshToken', 'supportsQuota', 'supportsCredits',
  'supportsStreaming', 'supportsVision', 'supportsToolCall', 'supportsMultipleAccounts',
  'needsCaptcha', 'loginMode', 'protocol',
]

export function validateManifest(input: unknown): ManifestValidationResult {
  const errors: ManifestViolation[] = []
  const violations: ManifestViolation[] = []
  const add = (path: string, message: string): void => { errors.push({ path, message }) }

  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: [{ path: '(root)', message: 'manifest must be an object' }], violations }
  }
  const m = input as Record<string, unknown>

  // apiVersion
  if (typeof m.apiVersion !== 'string' || !PROTOCOL_RE.test(m.apiVersion)) {
    add('apiVersion', 'apiVersion must be "MAJOR.MINOR"')
  }

  // extension
  const ext = m.extension as Record<string, unknown> | undefined
  if (typeof ext !== 'object' || ext === null) {
    add('extension', 'extension block is required')
  } else {
    if (typeof ext.id !== 'string' || !IDENT_RE.test(ext.id)) add('extension.id', 'extension.id must match [a-z0-9-]')
    if (typeof ext.version !== 'string' || !SEMVER_RE.test(ext.version)) add('extension.version', 'extension.version must be semver')
    if (typeof ext.displayName !== 'string' || ext.displayName.length === 0) add('extension.displayName', 'displayName is required')
  }

  // runtime
  const runtime = m.runtime as Record<string, unknown> | undefined
  if (typeof runtime !== 'object' || runtime === null) {
    add('runtime', 'runtime block is required')
  } else {
    if (typeof runtime.port !== 'number' || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535) {
      add('runtime.port', 'runtime.port must be an integer 1..65535')
    }
    if (typeof runtime.healthPath !== 'string' || !runtime.healthPath.startsWith('/')) {
      add('runtime.healthPath', 'runtime.healthPath must start with "/"')
    }
    const env = runtime.env
    if (env !== undefined) {
      if (!Array.isArray(env)) add('runtime.env', 'runtime.env must be an array')
      else env.forEach((e, i) => {
        const entry = e as Record<string, unknown>
        if (typeof entry?.name !== 'string' || !ENV_RE.test(entry.name)) violations.push({ path: `runtime.env[${i}].name`, message: 'env name is not a valid environment variable key' })
      })
    }
    const volumes = runtime.volumes
    if (volumes !== undefined) {
      if (!Array.isArray(volumes)) add('runtime.volumes', 'runtime.volumes must be an array')
      else volumes.forEach((v, i) => {
        const vol = v as Record<string, unknown>
        if (typeof vol?.mountPath !== 'string' || !vol.mountPath.startsWith('/') || vol.mountPath.includes('..')) {
          violations.push({ path: `runtime.volumes[${i}].mountPath`, message: 'mount path must be absolute and canonical' })
        } else if (RESERVED_MOUNT_PATHS.has(vol.mountPath) || /^\/(proc|sys|dev)\//.test(vol.mountPath)) {
          violations.push({ path: `runtime.volumes[${i}].mountPath`, message: `mount path "${vol.mountPath}" targets a reserved host path` })
        }
      })
    }
  }

  // security
  const security = m.security as Record<string, unknown> | undefined
  const perms = security?.permissions as Record<string, unknown> | undefined
  if (perms?.privileged === true) {
    violations.push({ path: 'security.permissions.privileged', message: 'privileged mode is not permitted in any manifest' })
  }

  // providers
  const providers = m.providers
  if (!Array.isArray(providers) || providers.length === 0) {
    add('providers', 'manifest must declare at least one provider')
  } else {
    const seenProviders = new Set<string>()
    providers.forEach((p, idx) => {
      const provider = p as Record<string, unknown>
      const pid = provider?.id
      const label = typeof pid === 'string' ? pid : String(idx)
      if (typeof pid !== 'string' || !IDENT_RE.test(pid)) add(`providers[${idx}].id`, 'provider.id must match [a-z0-9-]')
      else if (seenProviders.has(pid)) violations.push({ path: `providers[${label}].id`, message: `duplicate provider id "${pid}"` })
      else seenProviders.add(pid)
      if (typeof provider?.displayName !== 'string' || provider.displayName.length === 0) add(`providers[${idx}].displayName`, 'displayName is required')
      if (typeof provider?.protocol !== 'string' || provider.protocol.length === 0) add(`providers[${idx}].protocol`, 'protocol is required')

      const caps = provider?.capabilities as Record<string, unknown> | undefined
      if (typeof caps !== 'object' || caps === null) {
        add(`providers[${label}].capabilities`, 'capabilities block is required')
      } else {
        for (const key of CAPABILITY_KEYS) {
          if (key === 'protocol') continue
          if (key === 'loginMode') {
            if (typeof caps.loginMode !== 'string' || !LOGIN_MODES.includes(caps.loginMode as string)) {
              add(`providers[${label}].capabilities.loginMode`, 'loginMode must be a valid LoginMode')
            }
          } else if (typeof caps[key] !== 'boolean') {
            add(`providers[${label}].capabilities.${key}`, `${key} must be a boolean`)
          }
        }
      }

      // actions + authAction
      const actions = provider?.actions as Array<Record<string, unknown>> | undefined
      const actionIds = new Set<string>()
      if (actions !== undefined) {
        if (!Array.isArray(actions)) add(`providers[${label}].actions`, 'actions must be an array')
        else actions.forEach((a, i) => {
          const apath = `providers[${label}].actions[${i}]`
          if (typeof a?.id !== 'string' || !IDENT_RE.test(a.id)) add(`${apath}.id`, 'action.id must match [a-z0-9-]')
          else if (actionIds.has(a.id)) violations.push({ path: `${apath}.id`, message: `duplicate action id "${a.id}"` })
          else actionIds.add(a.id)
          if (a?.httpMethod !== 'GET' && a?.httpMethod !== 'POST') add(`${apath}.httpMethod`, 'httpMethod must be GET or POST')
          if (typeof a?.title !== 'string' || a.title.length === 0) add(`${apath}.title`, 'title is required')
          if (typeof a?.mode !== 'string' || !ACTIONS_MODES.includes(a.mode as string)) add(`${apath}.mode`, 'mode must be read|write|flow-control')
          if (typeof a?.sideEffects !== 'string' || !ACTIONS_SIDE_EFFECTS.includes(a.sideEffects as string)) add(`${apath}.sideEffects`, 'sideEffects must be none|idempotent|one-shot')
          if (typeof a?.ui !== 'string' || !ACTIONS_UI.includes(a.ui as string)) add(`${apath}.ui`, 'ui must be form|browser|none')
          if (a?.ui === 'none' && a?.httpMethod === 'GET' && a?.mode === 'write') {
            violations.push({ path: `${apath}.mode`, message: `GET action "${String(a.id)}" cannot be a write with no UI` })
          }
        })
      }
      const authAction = provider?.authAction
      if (authAction !== undefined) {
        const declared = (actions ?? []).find((a) => a.id === authAction)
        if (!declared) violations.push({ path: `providers[${label}].authAction`, message: `authAction "${String(authAction)}" is not a declared action` })
        else if (declared.httpMethod !== 'POST') violations.push({ path: `providers[${label}].authAction`, message: `authAction "${String(authAction)}" must be a POST action` })
      }
      if (caps?.needsCaptcha === true && !(actions ?? []).some((a) => a.mode === 'write')) {
        violations.push({ path: `providers[${label}].actions`, message: 'needsCaptcha providers must declare a submit-capable action' })
      }
    })
  }

  // distribution image shape
  const dist = m.distribution as Record<string, unknown> | undefined
  if (dist && typeof dist.image === 'string') {
    if (!/\/gateway-extension-[a-z0-9-]+$/.test(dist.image)) {
      violations.push({ path: 'distribution.image', message: `image "${dist.image}" must end with /gateway-extension-<id>` })
    }
    if (dist.image.startsWith('docker.io/')) {
      violations.push({ path: 'distribution.image', message: 'docker.io registries are not allowed (GHCR only in v1)' })
    }
  }

  return { ok: errors.length === 0 && violations.length === 0, errors, violations }
}
