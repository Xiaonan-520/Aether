/**
 * Extension management service (docs/EXTENSION_LIFECYCLE.md §5-§7).
 *
 * The service layer between Core's admin-authenticated HTTP routes and the
 * Extension Manager. Responsibilities:
 *
 *  - projection: merge Manager installState with a live runtime probe into
 *    the three-state model (install / runtime / health);
 *  - install-source policy (§6): only operator-built images following the
 *    `local/gateway-extension-<id>` naming convention at `tag === version`
 *    are accepted — no arbitrary registry inputs reach the Manager;
 *  - reload: re-run remote bootstrap so Core re-mounts an upgraded
 *    extension's providers (upgrade rotates the extension token);
 *  - action proxying (§7): opaque, manifest-whitelisted forwarding to the
 *    extension's /v1/actions/:actionId.
 *
 * It never logs or returns token material; Manager errors are surfaced with
 * stable error codes for the console to render.
 */

import { ManagerClient, ManagerClientError, type ManagerExtensionRecord } from './manager-client.js'
import { registerRemoteExtensions, type ManagerEndpoint } from '../http/remote-bootstrap.js'
import { RemoteExtensionClient } from '../protocol/extension/remote-provider.js'
import { OpenAIApiError } from '../protocol/openai/parse.js'
import type { ServiceContext } from './context.js'

/** Result of probing one extension's /health (container-network reachability). */
export type RuntimeState = 'running' | 'stopped' | 'unreachable' | 'unknown'
export type HealthState = 'healthy' | 'degraded' | 'unknown'

export interface ExtensionView {
  extensionId: string
  name: string
  version: string
  image: { repo: string; tag: string; digest: string | null }
  installState: string
  runtimeState: RuntimeState
  healthState: HealthState
  /** provider ids owned by this extension (1:N — never assume id equality) */
  providers: string[]
  /** derived: are these providers currently mounted in Core's registry */
  providersRegistered: boolean
  lastError: string | null
  installedAt: number
  updatedAt: number
}

const RUNTIME_PROBE_TIMEOUT_MS = 1_500
/** Probe results are cached briefly so list views don't hammer every container. */
const PROBE_CACHE_TTL_MS = 30_000

export class ExtensionService {
  private readonly client: ManagerClient
  private readonly fetchImpl: typeof fetch
  private readonly ctx: () => Pick<ServiceContext, 'store' | 'registry'>
  private readonly endpoint: ManagerEndpoint
  private readonly probeCache = new Map<string, { at: number; runtime: RuntimeState; health: HealthState }>()

  constructor(opts: {
    endpoint: ManagerEndpoint
    ctx: () => Pick<ServiceContext, 'store' | 'registry'>
    fetchImpl?: typeof fetch
  }) {
    this.client = new ManagerClient({ ...opts.endpoint, fetchImpl: opts.fetchImpl })
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.endpoint = opts.endpoint
    this.ctx = opts.ctx
  }

  // -- projections -----------------------------------------------------------

  async list(): Promise<ExtensionView[]> {
    let extensions: ManagerExtensionRecord[]
    try {
      extensions = (await this.client.list()).extensions
    } catch (err) {
      throw this.map(err)
    }
    return Promise.all(extensions.map((e) => this.project(e)))
  }

  async detail(extensionId: string): Promise<ExtensionView> {
    let rec: ManagerExtensionRecord
    try {
      rec = await this.client.get(extensionId)
    } catch (err) {
      throw this.map(err)
    }
    return this.project(rec)
  }

  async available(): Promise<{ extensions: ManagerExtensionRecord[] }> {
    try {
      return await this.client.available()
    } catch (err) {
      throw this.map(err)
    }
  }

  private async project(rec: ManagerExtensionRecord): Promise<ExtensionView> {
    const probe = await this.probe(rec)
    const providers = Array.isArray(rec.providerIds) ? rec.providerIds : []
    return {
      extensionId: rec.extensionId,
      name: rec.extensionId,
      version: rec.version,
      image: { repo: rec.imageRepo, tag: rec.imageTag, digest: rec.imageDigest },
      installState: rec.status,
      runtimeState: probe.runtime,
      healthState: probe.health,
      providers,
      providersRegistered: rec.status === 'installed'
        && probe.runtime === 'running'
        && providers.every((id) => this.ctx().registry.get(id) !== undefined),
      lastError: rec.error,
      installedAt: rec.installedAt,
      updatedAt: rec.updatedAt,
    }
  }

  private async probe(rec: ManagerExtensionRecord): Promise<{ runtime: RuntimeState; health: HealthState }> {
    const cached = this.probeCache.get(rec.extensionId)
    if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) {
      return { runtime: cached.runtime, health: cached.health }
    }
    const result = await this.probeUncached(rec)
    this.probeCache.set(rec.extensionId, { at: Date.now(), ...result })
    return result
  }

  async probeUncached(rec: ManagerExtensionRecord): Promise<{ runtime: RuntimeState; health: HealthState }> {
    const fetchImpl = this.fetchImpl
    if (rec.status === 'stopped') return { runtime: 'stopped', health: 'unknown' }
    if (!rec.endpointUrl) return { runtime: 'unknown', health: 'unknown' }
    // container-internal endpoint; only reachable from the gateway container
    try {
      const res = await fetchImpl(`${rec.endpointUrl}/health`, { signal: AbortSignal.timeout(RUNTIME_PROBE_TIMEOUT_MS) })
      if (res.ok) {
        const body = await res.json().catch(() => ({}) as { status?: string }) as { status?: string }
        return {
          runtime: 'running',
          health: body.status === 'healthy' ? 'healthy' : body.status === 'degraded' ? 'degraded' : 'unknown',
        }
      }
      return { runtime: 'running', health: 'unknown' }
    } catch {
      // unreachable but installed → the container exited without Manager knowing
      return { runtime: rec.status === 'installed' ? 'unreachable' : 'unknown', health: 'unknown' }
    }
  }

  // -- lifecycle -------------------------------------------------------------

  async install(body: { manifest: unknown; image?: { repo: string; tag: string; digest?: string } }): Promise<unknown> {
    const manifest = assertManifestObject(body?.manifest)
    const extensionId = assertExtensionId(manifest?.extension?.id)
    this.assertTrustedSource(extensionId, body?.image, manifest)
    try {
      return await this.client.install(body)
    } catch (err) {
      throw this.map(err)
    }
  }

  async upgrade(extensionId: string, body: { manifest: unknown; image?: { repo: string; tag: string; digest?: string } }): Promise<unknown> {
    assertExtensionId(extensionId)
    const manifest = assertManifestObject(body?.manifest)
    if (manifest?.extension?.id !== extensionId) {
      throw new OpenAIApiError(400, 'invalid_request_error',
        `manifest extension id "${manifest?.extension?.id}" does not match path "${extensionId}"`)
    }
    this.assertTrustedSource(extensionId, body?.image, manifest)
    try {
      return await this.client.upgrade(extensionId, body)
    } catch (err) {
      throw this.map(err)
    }
  }

  async stop(extensionId: string): Promise<{ ok: true }> {
    assertExtensionId(extensionId)
    try {
      await this.client.stop(extensionId)
      return { ok: true }
    } catch (err) {
      throw this.map(err)
    }
  }

  async restart(extensionId: string): Promise<{ ok: true }> {
    assertExtensionId(extensionId)
    try {
      await this.client.restart(extensionId)
      return { ok: true }
    } catch (err) {
      throw this.map(err)
    }
  }

  async remove(extensionId: string): Promise<{ ok: true }> {
    assertExtensionId(extensionId)
    try {
      await this.client.remove(extensionId)
      return { ok: true }
    } catch (err) {
      throw this.map(err)
    }
  }

  /**
   * Re-run remote bootstrap so Core re-mounts this extension's providers
   * (needed after upgrade rotates the extension token). Touches no container.
   */
  async reload(extensionId: string): Promise<{ ok: true; providers: string[] }> {
    assertExtensionId(extensionId)
    try {
      const detail = await this.client.get(extensionId)
      if (detail.status !== 'installed') {
        throw new OpenAIApiError(409, 'invalid_request_error',
          `extension "${extensionId}" is not installed (status=${detail.status})`, 'operation_in_progress')
      }
      await registerRemoteExtensions(this.ctx(), this.endpoint)
      const providers = Array.isArray(detail.providerIds) ? detail.providerIds : []
      return { ok: true, providers }
    } catch (err) {
      throw err instanceof OpenAIApiError ? err : this.map(err)
    }
  }

  // -- actions (§7) -----------------------------------------------------------

  /** Manifest-declared actions for one provider — the UI's form descriptor. */
  async listActions(extensionId: string, providerId: string): Promise<Array<Record<string, unknown>>> {
    try {
      const pkg = await this.client.registrationPackage(extensionId)
      const providers = (pkg.manifest as { providers?: Array<{ id?: string; actions?: Array<Record<string, unknown>> }> })?.providers ?? []
      const entry = providers.find((p) => p.id === providerId)
      if (!entry) {
        throw new OpenAIApiError(404, 'extension_not_found',
          `extension "${extensionId}" does not declare provider "${providerId}"`, 'extension_not_found')
      }
      return entry.actions ?? []
    } catch (err) {
      throw err instanceof OpenAIApiError ? err : this.map(err)
    }
  }

  /**
   * Opaque action invocation (§7): Core authenticates the caller, enforces
   * the manifest whitelist, then forwards the payload UNINTERPRETED to the
   * extension. The payload never touches Core storage.
   */
  async invokeAction(extensionId: string, providerId: string, actionId: string, payload: { accountId?: string; payload?: unknown }): Promise<unknown> {
    assertExtensionId(extensionId)
    assertExtensionId(providerId)
    assertExtensionId(actionId)
    try {
      const pkg = await this.client.registrationPackage(extensionId)
      const manifest = pkg.manifest as { providers?: Array<{ id?: string; actions?: Array<{ id?: string }> }> }
      const provider = manifest.providers?.find((p) => p.id === providerId)
      const declared = provider?.actions?.some((a) => a.id === actionId)
      if (!declared) {
        throw new OpenAIApiError(404, 'action_undeclared',
          `action "${actionId}" is not declared by provider "${providerId}"`, 'action_undeclared')
      }
      const client = new RemoteExtensionClient({
        endpoints: { baseUrl: pkg.endpointUrl, token: pkg.token },
      })
      return await client.invokeAction({
        actionId,
        accountId: payload?.accountId,
        payload: payload?.payload,
      })
    } catch (err) {
      throw err instanceof OpenAIApiError ? err : this.map(err)
    }
  }

  // -- install-source policy (§6) ---------------------------------------------

  /**
   * Only operator-built images following the naming convention are trusted:
   * repo === `local/gateway-extension-<extensionId>` and tag === manifest
   * version. Registry/digest pinning can be layered here later without
   * changing the API shape.
   */
  private assertTrustedSource(extensionId: string, image: { repo?: string; tag?: string; digest?: string } | undefined, manifest: { extension?: { version?: string } } | undefined): void {
    if (!image) return // Manager default naming applies, which matches the convention
    const expectedRepo = `local/gateway-extension-${extensionId}`
    if (image.repo !== expectedRepo) {
      throw new OpenAIApiError(400, 'invalid_request_error',
        `untrusted image source "${image.repo}": this deployment only accepts ${expectedRepo}`, 'forbidden_image_source')
    }
    const expectedTag = manifest?.extension?.version
    if (expectedTag && image.tag !== expectedTag) {
      throw new OpenAIApiError(400, 'invalid_request_error',
        `image tag "${image.tag}" must match the manifest version "${expectedTag}"`, 'forbidden_image_source')
    }
  }

  /** ManagerClientError → OpenAIApiError with stable codes for the console. */
  private map(err: unknown): Error {
    if (err instanceof ManagerClientError) {
      const code = err.code
      if (code === 'extension_not_found') {
        return new OpenAIApiError(404, 'extension_not_found', err.message, 'extension_not_found')
      }
      if (code === 'manager_unavailable') {
        return new OpenAIApiError(503, 'manager_unavailable', err.message, 'manager_unavailable')
      }
      if (code === 'manager_auth_misconfigured') {
        return new OpenAIApiError(502, 'manager_auth_misconfigured', err.message, 'manager_auth_misconfigured')
      }
      if (code === 'manager_error' && err.status === 409) {
        return new OpenAIApiError(409, 'operation_in_progress', err.message, 'operation_in_progress')
      }
      // busy lock from the manager surfaces as a 400 with message; detect it
      if (code === 'manager_error' && /is busy/.test(err.message)) {
        return new OpenAIApiError(409, 'operation_in_progress', err.message, 'operation_in_progress')
      }
      return new OpenAIApiError(502, 'manager_error', err.message, 'manager_error')
    }
    return err instanceof Error ? err : new Error(String(err))
  }
}

// -- input validation -----------------------------------------------------------

function assertManifestObject(manifest: unknown): { extension?: { id?: string; version?: string } } | undefined {
  if (manifest === undefined || manifest === null) {
    throw new OpenAIApiError(400, 'invalid_request_error', 'manifest is required')
  }
  if (typeof manifest !== 'object') {
    throw new OpenAIApiError(400, 'invalid_request_error', 'manifest must be an object')
  }
  const ext = (manifest as { extension?: unknown }).extension
  if (!ext || typeof ext !== 'object') {
    throw new OpenAIApiError(400, 'invalid_request_error', 'manifest.extension is required')
  }
  return manifest as { extension?: { id?: string; version?: string } }
}

function assertExtensionId(id: unknown): string {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new OpenAIApiError(400, 'invalid_request_error', 'extension id must match [a-z0-9][a-z0-9-]{0,63}')
  }
  return id
}
