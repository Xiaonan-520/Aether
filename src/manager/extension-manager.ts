/**
 * Extension Manager (RFC v2 §17, §19.5).
 *
 * The ONLY component with container lifecycle power, exercised through a
 * ContainerRuntime (Docker in production, local processes in dev/tests). The
 * HTTP API it exposes is high-level lifecycle semantics with strong token
 * auth — never a Docker passthrough.
 *
 * Install flow (RFC §"Extension Installation Flow"), every step observable
 * in the persisted status:
 *
 *   pending → validating → pulling → starting → health_check
 *           → conformance → registering → installed
 *   any failure → cleanup → failed (no half-installed state)
 *
 * Lifecycle is deliberately one-directional: Core never writes extension
 * state except through the explicit lifecycle verbs below.
 */

import { createHash, randomBytes } from 'node:crypto'
import { validateManifest } from '../protocol/extension/validate-manifest.js'
import { runConformanceSuite } from '../protocol/extension/conformance.js'
import type { ExtensionManifest } from '../protocol/extension/manifest.js'
import type { ContainerRuntime, ImageRef } from './runtime.js'
import { sanitizeRuntime, RuntimePolicyError } from './policy.js'
import { ManagerStore, type ExtensionStatus, type InstallRecord } from './store.js'
import { CredentialCipher } from '../store/crypto.js'

export interface ManagerOptions {
  store: ManagerStore
  runtime: ContainerRuntime
  /** manager→extension bearer token issuer; defaults to random per install */
  issueToken?: () => string
  /** wall-clock budget for the whole install (health wait lives inside) */
  healthTimeoutMs?: number
  /** operator env values keyed by manifest-allowlisted names */
  operatorEnv?: Record<string, string>
  network?: string
  /**
   * Secret used to encrypt registration tokens at rest (RFC §10.3 pattern:
   * only fingerprints are queryable; the token material itself is sealed).
   * When absent, registration packages are unavailable.
   */
  registrationSecret?: string
}

export type InstallSource =
  | { kind: 'manifest'; manifest: ExtensionManifest; image?: ImageRef }
  /** Phase 3+ will add github-release / ghcr sources; Phase 2 accepts
   *  pre-fetched manifests (fake extension registers a local image). */

export interface InstallResult {
  extensionId: string
  status: ExtensionStatus
  endpointUrl: string
  providers: Array<{ id: string; displayName: string }>
}

/** What Core consumes to mount a remote extension as providers (§17.2 step 5). */
export interface RegistrationPackage {
  manifest: ExtensionManifest
  /** container-internal endpoint, e.g. http://gw-ext-lobsterai:8080 */
  endpointUrl: string
  /** manager-issued extension token (sealed at rest, plaintext only here) */
  token: string
}

export class ExtensionManager {
  private readonly store: ManagerStore
  private readonly runtime: ContainerRuntime
  private readonly healthTimeoutMs: number
  private readonly operatorEnv: Record<string, string>
  private readonly network: string
  private readonly issueToken: () => string
  /** seals registration tokens at rest; null = registration disabled */
  private readonly registrationCipher: CredentialCipher | null

  constructor(opts: ManagerOptions) {
    this.store = opts.store
    this.runtime = opts.runtime
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 30_000
    this.operatorEnv = opts.operatorEnv ?? {}
    this.network = opts.network ?? 'gw-ext-net'
    this.issueToken = opts.issueToken ?? (() => randomBytes(32).toString('base64url'))
    this.registrationCipher = opts.registrationSecret
      ? new CredentialCipher(opts.registrationSecret)
      : null
  }

  // -------------------------------------------------------------------------
  // install
  // -------------------------------------------------------------------------

  async install(source: InstallSource): Promise<InstallResult> {
    if (source.kind !== 'manifest') {
      throw new Error('only pre-fetched manifest installs are supported in Phase 2')
    }
    const manifest = source.manifest
    const extensionId = manifest.extension.id

    if (this.store.get(extensionId)) {
      throw new Error(`extension "${extensionId}" is already installed`)
    }
    const now = Date.now()
    const extensionToken = this.issueToken()
    const record: InstallRecord = {
      extensionId,
      version: manifest.extension.version,
      imageRepo: source.image?.repo ?? `local/gateway-extension-${extensionId}`,
      imageTag: source.image?.tag ?? manifest.extension.version,
      imageDigest: source.image?.digest ?? null,
      containerId: null,
      endpointUrl: null,
      status: 'pending',
      manifestHash: `sha256:${sha256Json(manifest)}`,
      tokenFingerprint: sha256Hex(extensionToken),
      error: null,
      installedAt: now,
      updatedAt: now,
    }
    this.store.upsert(record)

    try {
      // 1. validate manifest (shape + security constraints)
      this.setStatus(extensionId, 'validating')
      const validation = validateManifest(manifest)
      if (!validation.ok) {
        const detail = [...validation.errors, ...validation.violations]
          .map((v) => `${v.path}: ${v.message}`).join('; ')
        throw new Error(`manifest rejected: ${detail}`)
      }

      // 2. image policy + pull (pinned digest recorded)
      this.setStatus(extensionId, 'pulling')
      const image: ImageRef = {
        repo: record.imageRepo,
        tag: record.imageTag,
        digest: source.image?.digest,
      }
      const { digest } = await this.runtime.pullImage(image)
      record.imageDigest = digest

      // 3. manifest → sanitized runtime spec (the conversion boundary)
      const spec = sanitizeRuntime({
        manifest,
        image: { ...image, digest },
        injectedEnv: {
          GATEWAY_EXTENSION_TOKEN: extensionToken,
          GATEWAY_EXTENSION_ID: extensionId,
        },
        limits: { network: this.network, operatorEnv: this.operatorEnv },
      })

      // 4. create + start
      this.setStatus(extensionId, 'starting')
      const handle = await this.runtime.createContainer(spec)
      record.containerId = handle.containerId
      record.endpointUrl = handle.endpointUrl
      await this.runtime.start(handle.containerId)

      // 5. wait for health
      this.setStatus(extensionId, 'health_check')
      await this.waitHealthy(handle.endpointUrl)

      // 6. manifest handshake — served manifest must match the installed one
      const servedManifest = await this.fetchServedManifest(handle.endpointUrl, extensionToken)
      if (sha256Json(servedManifest) !== record.manifestHash.replace(/^sha256:/, '')) {
        throw new Error('manifest mismatch: served /manifest differs from installed manifest')
      }

      // 7. conformance gate — failure MUST prevent registration
      this.setStatus(extensionId, 'conformance')
      const suite = await runConformanceSuite(
        servedManifest,
        new AuthedTransport(handle.endpointUrl, extensionToken),
      )
      if (!suite.pass) {
        const failed = suite.domains.filter((d) => !d.pass)
          .map((d) => `${d.domain}: ${d.checks.filter((c) => !c.pass).map((c) => c.id).join(',')}`)
          .join('; ')
        throw new Error(`conformance gate failed: ${failed}`)
      }

      // 8. persist final record (registration into Core happens via
      //    listRegisterable() + the registration package on the Core side)
      this.setStatus(extensionId, 'installed')
      record.status = 'installed'
      this.store.upsert(record)
      this.sealRegistrationToken(extensionId, extensionToken)
      return {
        extensionId,
        status: 'installed',
        endpointUrl: handle.endpointUrl,
        providers: manifest.providers.map((p) => ({ id: p.id, displayName: p.displayName })),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // cleanup: no half-installed state. Cleanup failures are recorded.
      await this.cleanup(extensionId, record.containerId).catch((cleanupErr) => {
        console.error(`[manager] cleanup failed for ${extensionId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
      })
      this.setStatus(extensionId, 'failed', message)
      record.error = message
      record.status = 'failed'
      this.store.upsert(record)
      throw err instanceof RuntimePolicyError ? err : new Error(`install failed: ${message}`)
    }
  }

  // -------------------------------------------------------------------------
  // lifecycle verbs
  // -------------------------------------------------------------------------

  async stop(extensionId: string): Promise<void> {
    const rec = this.mustGet(extensionId)
    if (!rec.containerId) throw new Error(`extension "${extensionId}" has no container`)
    try {
      await this.runtime.stop(rec.containerId)
      this.setStatus(extensionId, 'failed', 'stopped by operator')
    } catch (err) {
      const message = `stop failed: ${err instanceof Error ? err.message : String(err)}`
      this.setStatus(extensionId, rec.status, message)
      throw new Error(message)
    }
  }

  async restart(extensionId: string): Promise<void> {
    const rec = this.mustGet(extensionId)
    if (!rec.containerId) throw new Error(`extension "${extensionId}" has no container`)
    await this.runtime.stop(rec.containerId)
    await this.runtime.start(rec.containerId)
    await this.waitHealthy(rec.endpointUrl!)
    this.setStatus(extensionId, 'installed')
  }

  async remove(extensionId: string): Promise<void> {
    const rec = this.mustGet(extensionId)
    this.setStatus(extensionId, 'removing')
    try {
      if (rec.containerId) {
        await this.runtime.stop(rec.containerId)
        await this.runtime.remove(rec.containerId)
      }
      this.store.delete(extensionId)
      this.store.deleteRegistrationToken(extensionId)
    } catch (err) {
      const message = `remove failed: ${err instanceof Error ? err.message : String(err)}`
      this.setStatus(extensionId, rec.status, message)
      throw new Error(message)
    }
  }

  list(): InstallRecord[] {
    return this.store.list()
  }

  /**
   * The package Core needs to mount this extension's providers (RFC §17.2
   * step 5): the validated manifest, the container-internal endpoint and the
   * install-time extension token. The token exists ONLY inside the manager's
   * own sealed storage — this is the single retrieval point and it never
   * appears in any list/get projection. Requires registrationSecret.
   */
  async registrationPackage(extensionId: string): Promise<RegistrationPackage> {
    if (!this.registrationCipher) {
      throw new Error('manager has no registrationSecret; registration packages are disabled')
    }
    const rec = this.mustGet(extensionId)
    if (rec.status !== 'installed' || !rec.endpointUrl) {
      throw new Error(`extension "${extensionId}" is not installed (status=${rec.status})`)
    }
    const sealed = this.store.getRegistrationToken(extensionId)
    if (!sealed) throw new Error(`no sealed registration token for "${extensionId}"`)
    const token = this.registrationCipher.decryptJson<string>(sealed)
    const served = await this.fetchServedManifest(rec.endpointUrl, token)
    return { manifest: served, endpointUrl: rec.endpointUrl, token }
  }

  private sealRegistrationToken(extensionId: string, token: string): void {
    if (!this.registrationCipher) return
    this.store.putRegistrationToken(extensionId, this.registrationCipher.encryptJson(token))
  }

  get(extensionId: string): InstallRecord | undefined {
    return this.store.get(extensionId)
  }

  /** Installed + healthy extensions a Core may register RemoteProviders from. */
  async listRegisterable(): Promise<InstallRecord[]> {
    return this.store.list().filter((r) => r.status === 'installed')
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private mustGet(extensionId: string): InstallRecord {
    const rec = this.store.get(extensionId)
    if (!rec) throw new Error(`unknown extension "${extensionId}"`)
    return rec
  }

  private setStatus(extensionId: string, status: ExtensionStatus, error?: string): void {
    this.store.setStatus(extensionId, status, error)
  }

  private async waitHealthy(endpointUrl: string, token?: string): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs
    let lastError = 'no attempt'
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${endpointUrl}/health`, {
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
          signal: AbortSignal.timeout(2_000),
        })
        if (res.ok) {
          const body = await res.json() as { status?: string }
          if (body.status === 'healthy' || body.status === 'degraded') return
          lastError = `health status ${String(body.status)}`
        } else {
          lastError = `health http ${res.status}`
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
      await sleep(200)
    }
    throw new Error(`health timeout: ${lastError}`)
  }

  private async fetchServedManifest(endpointUrl: string, token: string): Promise<ExtensionManifest> {
    const res = await fetch(`${endpointUrl}/manifest`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) throw new Error(`GET /manifest -> ${res.status}`)
    return await res.json() as ExtensionManifest
  }

  private async cleanup(extensionId: string, containerId: string | null): Promise<void> {
    if (containerId) {
      await this.runtime.stop(containerId).catch(() => undefined)
      await this.runtime.remove(containerId)
    }
    // the failed record intentionally REMAINS (with status=failed) so the
    // operator can see why; only containers are cleaned up.
    void extensionId
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Minimal transport carrying the manager-issued token (for the suite). */
export class AuthedTransport {
  constructor(private readonly baseUrl: string, private readonly token: string) {}
  manifest(): Promise<unknown> {
    return fetch(`${this.baseUrl}/manifest`, { headers: { authorization: `Bearer ${this.token}` } })
      .then((r) => r.json())
  }
  health(): Promise<{ status: string }> {
    return fetch(`${this.baseUrl}/health`, { headers: { authorization: `Bearer ${this.token}` } })
      .then((r) => r.json())
  }
}

export function sha256Json(value: unknown): string {
  return sha256Hex(JSON.stringify(value))
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
