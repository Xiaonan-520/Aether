/**
 * Manifest → Sanitized Runtime policy (RFC v2 §"Manifest → Docker 的转换边界",
 * §19.5). THE security boundary of Phase 2.
 *
 * The manifest is an installation intent — never a Docker API. This module is
 * the ONLY place that turns one into container parameters, and it is
 * deliberately total: every field of the output is decided HERE (deny-by-
 * default), the manifest only contributes values that pass validation.
 *
 * What the manifest may influence:
 *   - container-internal port (runtime.port)
 *   - health path (runtime.healthPath)
 *   - named volume mounts it declares (names namespaced by extension id)
 *   - env entries on its runtime.env allowlist (values supplied by operator)
 *   - memory/cpu limits it declares (clamped to manager ceilings)
 *
 * What it may NEVER influence (hardcoded below / asserted in tests):
 *   - privileged mode, capabilities (always dropped), new privileges
 *   - host paths / bind mounts / docker.sock
 *   - published ports, network topology (manager-internal network only)
 *   - entrypoint, command, user, restart policy, labels carrying arbitrary
 *     docker options
 */

import type { ExtensionManifest } from '../protocol/extension/manifest.js'
import type { ImageRef, SanitizedContainerSpec } from './runtime.js'

/** Manager-side ceilings (clamp whatever the manifest asks for). */
export interface ManagerPolicyLimits {
  network: string
  maxMemoryBytes: number
  maxNanoCpus: number
  /** operator env values are taken from this map; manifest may only name keys */
  operatorEnv: Record<string, string>
}

export const DEFAULT_POLICY_LIMITS: Omit<ManagerPolicyLimits, 'operatorEnv'> = {
  network: 'gw-ext-net',
  maxMemoryBytes: 512 * 1024 * 1024,
  maxNanoCpus: 1_000_000_000, // 1 CPU
}

export class RuntimePolicyError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'RuntimePolicyError'
    this.path = path
  }
}

const ONE_BYTE_SUFFIX: Record<string, number> = {
  b: 1, k: 1024, kb: 1024, ki: 1024, kib: 1024,
  m: 1024 ** 2, mb: 1024 ** 2, mi: 1024 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, gi: 1024 ** 3, gib: 1024 ** 3,
}

export function parseMemoryBytes(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/.exec(value.trim())
  if (!m) return undefined
  const factor = ONE_BYTE_SUFFIX[m[2].toLowerCase()]
  if (!factor) return undefined
  return Math.floor(Number(m[1]) * factor)
}

export function parseNanoCpus(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)$/.exec(value.trim())
  if (!m) return undefined
  return Math.floor(Number(m[1]) * 1_000_000_000)
}

export interface SanitizeInput {
  manifest: ExtensionManifest
  image: ImageRef
  /** manager-issued auth material, injected as env — never operator-visible */
  injectedEnv: Record<string, string>
  limits?: Partial<ManagerPolicyLimits>
}

/**
 * Turn a VALIDATED manifest + pinned image into the exact container spec the
 * runtime will create. Throws RuntimePolicyError on any intent the manager
 * refuses. Every output field is decided here; nothing is passed through.
 */
export function sanitizeRuntime(input: SanitizeInput): SanitizedContainerSpec {
  const { manifest, image } = input
  const limits: ManagerPolicyLimits = {
    network: input.limits?.network ?? DEFAULT_POLICY_LIMITS.network,
    maxMemoryBytes: input.limits?.maxMemoryBytes ?? DEFAULT_POLICY_LIMITS.maxMemoryBytes,
    maxNanoCpus: input.limits?.maxNanoCpus ?? DEFAULT_POLICY_LIMITS.maxNanoCpus,
    operatorEnv: input.limits?.operatorEnv ?? {},
  }

  // image policy: immutable tag only; "latest" is never an install target
  if (image.tag === 'latest') {
    throw new RuntimePolicyError('image.tag', '"latest" is not an immutable install target')
  }
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*:[A-Za-z0-9._-]+$/.test(`${image.repo}:${image.tag}`)) {
    throw new RuntimePolicyError('image', `malformed image reference "${image.repo}:${image.tag}"`)
  }

  // volumes: named only; manager namespaces the volume name per extension.
  const volumes = (manifest.runtime.volumes ?? []).map((v) => {
    if (!v.mountPath.startsWith('/') || v.mountPath.includes('..')) {
      throw new RuntimePolicyError(`runtime.volumes[${v.name}].mountPath`, 'mount path must be absolute and canonical')
    }
    return { name: `gw-ext-${manifest.extension.id}-${v.name}`, mountPath: v.mountPath }
  })

  // env: manifest NAMES keys, values come only from injectedEnv (manager
  // auth material) or operatorEnv (operator-supplied allowlisted values).
  const env: Record<string, string> = { ...input.injectedEnv }
  for (const decl of manifest.runtime.env ?? []) {
    // env keys must be plausible names — no injection vectors through
    // manifest-declared keys
    if (!/^[A-Z_][A-Z0-9_]*$/.test(decl.name)) {
      throw new RuntimePolicyError(`runtime.env[${decl.name}]`, 'env name is not a valid environment variable key')
    }
    const operatorValue = limits.operatorEnv[decl.name]
    if (operatorValue !== undefined) env[decl.name] = operatorValue
    else if (decl.default !== undefined && decl.required === false) env[decl.name] = decl.default
    else if (decl.required) {
      throw new RuntimePolicyError(`runtime.env[${decl.name}]`, 'required env has no operator value')
    }
  }

  // resources: clamp to manager ceilings
  const memoryBytes = manifest.runtime.resources?.memory !== undefined
    ? parseMemoryBytes(manifest.runtime.resources.memory)
    : undefined
  if (memoryBytes !== undefined && memoryBytes > limits.maxMemoryBytes) {
    throw new RuntimePolicyError('runtime.resources.memory', `requests ${memoryBytes} bytes, ceiling is ${limits.maxMemoryBytes}`)
  }
  const nanoCpus = manifest.runtime.resources?.cpus !== undefined
    ? parseNanoCpus(manifest.runtime.resources.cpus)
    : undefined
  if (nanoCpus !== undefined && nanoCpus > limits.maxNanoCpus) {
    throw new RuntimePolicyError('runtime.resources.cpus', `requests ${nanoCpus} nanoCPUs, ceiling is ${limits.maxNanoCpus}`)
  }

  return {
    name: `gw-ext-${manifest.extension.id}`,
    image,
    env,
    // fixed labels only — no caller-supplied labels can reach the runtime
    labels: {
      'gw.extension.id': manifest.extension.id,
      'gw.extension.version': manifest.extension.version,
      'gw.extension.image_digest': image.digest ?? '',
      'gw.managed-by': 'extension-manager',
    },
    network: limits.network,
    port: manifest.runtime.port,
    volumes,
    capDrop: 'ALL',
    privileged: false,
    readonlyRootfs: true,
    tmpfs: ['/tmp'],
    noNewPrivileges: true,
    restartPolicy: 'unless-stopped',
    memoryBytes,
    nanoCpus,
  } satisfies SanitizedContainerSpec
}
