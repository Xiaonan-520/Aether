/**
 * Manifest validator (RFC v2 §12).
 *
 * The manifest is an INSTALLATION INTENT + CAPABILITY DECLARATION — never a
 * Docker API. Anything that could express host control (hostPath volumes,
 * privileged mode, docker.sock mounts, arbitrary Linux capabilities) is
 * rejected here at validation time, before the future Extension Manager ever
 * turns the document into container parameters (deny-by-default there).
 *
 * Pure function: zod in, structured result out. No I/O, no side effects.
 */

import { z } from 'zod'
import type { ExtensionManifest } from './manifest.js'
import { isValidIdentifier } from './namespace.js'

// ---------------------------------------------------------------------------
// zod schema — wire format
// ---------------------------------------------------------------------------

const semverRe = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const protocolVersionRe = /^(\d+)\.(\d+)$/
const jsonSchemaRe = protocolVersionRe
const identifierRe = /^[a-z0-9][a-z0-9-]{0,63}$/
const isoInstantRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Structural JSON Schema subset used for action input/output schemas. We do
 * not implement full JSON Schema — just enough to catch broken declarations
 * (this mirrors the conformance suite's structural checks).
 */
const jsonSchemaNode: z.ZodType<Record<string, unknown>> = z
  .record(z.unknown())
  .superRefine((node, ctx) => {
    const t = node.type
    const knownTypes = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
    if (t !== undefined && !knownTypes.includes(t as string)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `schema.type "${String(t)}" is not a known JSON Schema type` })
    }
    if (t === 'object' || node.properties !== undefined) {
      if (node.properties !== undefined && (typeof node.properties !== 'object' || node.properties === null || Array.isArray(node.properties))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'schema.properties must be an object' })
      }
      if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some((r) => typeof r !== 'string'))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'schema.required must be an array of strings' })
      }
    }
    if (t === 'array' && node.items !== undefined && (typeof node.items !== 'object' || node.items === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'schema.items must be an object' })
    }
  })

const actionSchema = z.object({
  id: z.string().regex(identifierRe, 'action.id must match [a-z0-9-]'),
  httpMethod: z.enum(['GET', 'POST']),
  title: z.string().min(1),
  mode: z.enum(['read', 'write', 'flow-control']),
  sideEffects: z.enum(['none', 'idempotent', 'one-shot']),
  ui: z.enum(['form', 'browser', 'none']),
  inputSchema: jsonSchemaNode.optional(),
  outputSchema: jsonSchemaNode.optional(),
}).strict()

const capabilitiesSchema = z.object({
  supportsOAuth: z.boolean(),
  supportsRefreshToken: z.boolean(),
  supportsQuota: z.boolean(),
  supportsCredits: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsVision: z.boolean(),
  supportsToolCall: z.boolean(),
  supportsMultipleAccounts: z.boolean(),
  needsCaptcha: z.boolean(),
  loginMode: z.enum(['oauth', 'device-code', 'external-link', 'sms', 'disk-credential', 'import']),
  protocol: z.enum(['openai-chat', 'anthropic-messages']),
}).strict()

const providerEntrySchema = z.object({
  id: z.string().regex(identifierRe, 'provider.id must match [a-z0-9-]'),
  displayName: z.string().min(1),
  protocol: z.string().min(1),
  capabilities: capabilitiesSchema,
  fallbackModels: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    capabilities: z.object({
      vision: z.boolean().optional(),
      toolCall: z.boolean().optional(),
      streaming: z.boolean().optional(),
      reasoningEfforts: z.array(z.string()).optional(),
    }).optional(),
  })).optional(),
  actions: z.array(actionSchema).optional(),
  authAction: z.string().min(1).optional(),
  accountFields: z.array(z.object({
    name: z.string().min(1),
    required: z.boolean(),
    description: z.string().optional(),
  })).optional(),
}).strict()

const manifestSchema = z.object({
  apiVersion: z.string().regex(protocolVersionRe, 'apiVersion must be "MAJOR.MINOR"'),
  extension: z.object({
    id: z.string().regex(identifierRe, 'extension.id must match [a-z0-9-]'),
    version: z.string().regex(semverRe, 'extension.version must be semver'),
    displayName: z.string().min(1),
    description: z.string().optional(),
    author: z.string().optional(),
    license: z.string().optional(),
    repository: z.string().optional(),
  }).strict(),
  distribution: z.object({
    image: z.string().min(1),
    tag: z.string().min(1),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'digest must be "sha256:<64 hex>"').optional(),
    releaseUrl: z.string().url().optional(),
  }).optional(),
  runtime: z.object({
    port: z.number().int().min(1).max(65535),
    healthPath: z.string().startsWith('/'),
    env: z.array(z.object({
      name: z.string().min(1),
      required: z.boolean(),
      default: z.string().optional(),
    }).strict()).optional(),
    volumes: z.array(z.object({
      name: z.string().min(1),
      mountPath: z.string().startsWith('/'),
      purpose: z.string().optional(),
    }).strict()).optional(),
    resources: z.object({
      memory: z.string().optional(),
      cpus: z.string().optional(),
    }).strict().optional(),
  }).strict(),
  security: z.object({
    permissions: z.object({
      network: z.object({ domains: z.array(z.string().min(1)) }).strict().optional(),
      filesystem: z.literal('named-volumes-only').optional(),
      capabilities: z.array(z.string()).optional(),
      privileged: z.boolean().optional(),
    }).strict().optional(),
    secrets: z.array(z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      required: z.boolean(),
    }).strict()).optional(),
  }).strict().optional(),
  providers: z.array(providerEntrySchema).min(1, 'manifest must declare at least one provider'),
}).strict()

// ---------------------------------------------------------------------------
// Security hard rules — the "not a Docker API" line (RFC v2 §12, §19.5)
// ---------------------------------------------------------------------------

const RESERVED_MOUNT_PATHS = new Set(['/var/run/docker.sock', '/var/run', '/proc', '/sys', '/dev'])

export type ManifestViolation = { path: string; message: string }

export interface ManifestValidationResult {
  ok: boolean
  /** shape/schema problems (zod issues) */
  errors: ManifestViolation[]
  /** security-constraint problems — always fatal, never warnings */
  violations: ManifestViolation[]
}

/** Whether the manifest's major apiVersion is one this Core can speak. */
export function isSupportedApiVersion(apiVersion: string, supportedMajors: readonly number[] = [1]): boolean {
  const match = protocolVersionRe.exec(apiVersion)
  if (!match) return false
  return supportedMajors.includes(Number(match[1]))
}

function securityViolations(manifest: ExtensionManifest): ManifestViolation[] {
  const out: ManifestViolation[] = []
  const add = (path: string, message: string) => out.push({ path, message })

  // privileged / capabilities declarations are audit-only but Manager will
  // ALWAYS create non-privileged containers — an explicit `privileged: true`
  // intent is therefore contradictory and rejected outright.
  if (manifest.security?.permissions?.privileged === true) {
    add('security.permissions.privileged', 'privileged mode is not permitted in any manifest')
  }

  // volumes: named volumes only; never host paths, never the docker socket.
  for (const [i, vol] of (manifest.runtime.volumes ?? []).entries()) {
    if (RESERVED_MOUNT_PATHS.has(vol.mountPath) || vol.mountPath.startsWith('/proc/') || vol.mountPath.startsWith('/sys/') || vol.mountPath.startsWith('/dev/')) {
      add(`runtime.volumes[${i}].mountPath`, `mount path "${vol.mountPath}" targets a reserved host path`)
    }
  }

  // env names must be plausible env keys (no LD_PRELOAD-style injection games)
  for (const [i, env] of (manifest.runtime.env ?? []).entries()) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(env.name)) {
      add(`runtime.env[${i}].name`, `env name "${env.name}" is not a valid environment variable key`)
    }
  }

  // actions must not smell like host control
  for (const p of manifest.providers) {
    for (const [i, action] of (p.actions ?? []).entries()) {
      const path = `providers[${p.id}].actions[${i}]`
      if (action.ui === 'none' && action.httpMethod === 'GET' && action.mode === 'write') {
        add(`${path}.mode`, `GET action "${action.id}" cannot be a write with no UI`)
      }
    }
    // the auth action must be a declared POST action (credential channel, §10.3)
    if (p.authAction !== undefined) {
      const declared = (p.actions ?? []).find((a) => a.id === p.authAction)
      if (!declared) {
        add(`providers[${p.id}].authAction`, `authAction "${p.authAction}" is not a declared action`)
      } else if (declared.httpMethod !== 'POST') {
        add(`providers[${p.id}].authAction`, `authAction "${p.authAction}" must be a POST action`)
      }
    }
  }

  return out
}

function crossFieldViolations(manifest: ExtensionManifest): ManifestViolation[] {
  const out: ManifestViolation[] = []
  const add = (path: string, message: string) => out.push({ path, message })

  // provider ids must be globally unique across the whole manifest…
  const seen = new Set<string>()
  for (const p of manifest.providers) {
    if (seen.has(p.id)) add(`providers[${p.id}].id`, `duplicate provider id "${p.id}"`)
    seen.add(p.id)
    // …and must not collide with the extension id namespace either way
    if (p.id === manifest.extension.id) {
      // NOT an error (extension_id !== provider_id is normal, e.g. "zcode"),
      // but a provider named like ANOTHER extension is meaningless here since
      // extensions cannot reference each other — nothing to check.
    }
    // action ids unique within a provider
    const actionIds = new Set<string>()
    for (const [i, a] of (p.actions ?? []).entries()) {
      if (actionIds.has(a.id)) add(`providers[${p.id}].actions[${i}].id`, `duplicate action id "${a.id}"`)
      actionIds.add(a.id)
    }
    // manual-action-relevant consistency: captcha capability requires an action pair
    if (p.capabilities.needsCaptcha && !(p.actions ?? []).some((a) => a.mode === 'write')) {
      add(`providers[${p.id}].actions`, `needsCaptcha providers must declare a submit-capable action (official widget + human completion, no solver)`)
    }
    // fallbackModels ids unique within provider
    const modelIds = new Set<string>()
    for (const [i, m] of (p.fallbackModels ?? []).entries()) {
      if (modelIds.has(m.id)) add(`providers[${p.id}].fallbackModels[${i}].id`, `duplicate model id "${m.id}"`)
      modelIds.add(m.id)
    }
  }

  // distribution image must point at a gateway-extension repo shape
  const dist = manifest.distribution
  if (dist) {
    if (!/\/gateway-extension-[a-z0-9-]+$/.test(dist.image)) {
      add('distribution.image', `image "${dist.image}" must end with /gateway-extension-<id>`)
    }
    if (dist.image.split('/gateway-extension-')[0] === 'docker.io' || dist.image.startsWith('docker.io/')) {
      add('distribution.image', 'docker.io registries are not allowed (GHCR only in v1)')
    }
  }

  return out
}

/** Full validation: shape errors + security violations + cross-field rules. */
export function validateManifest(input: unknown, opts: { supportedMajors?: readonly number[] } = {}): ManifestValidationResult {
  const parsed = manifestSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
      violations: [],
    }
  }
  const manifest = parsed.data as unknown as ExtensionManifest

  const violations: ManifestViolation[] = [
    ...securityViolations(manifest),
    ...crossFieldViolations(manifest),
  ]
  if (!isSupportedApiVersion(manifest.apiVersion, opts.supportedMajors)) {
    violations.push({
      path: 'apiVersion',
      message: `apiVersion "${manifest.apiVersion}" major is not supported (supported majors: ${(opts.supportedMajors ?? [1]).join(', ')})`,
    })
  }
  if (!isValidIdentifier(manifest.extension.id)) {
    violations.push({ path: 'extension.id', message: 'extension.id must be [a-z0-9-]' })
  }

  return { ok: violations.length === 0, errors: [], violations }
}
