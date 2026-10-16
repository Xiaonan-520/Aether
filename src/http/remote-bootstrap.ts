/**
 * Core-side extension registration (RFC §17.2 step 5, Phase 3 minimal form).
 *
 * Pulls registration packages from the Extension Manager and mounts each
 * installed extension as remote providers in the registry. Zero provider
 * knowledge crosses this boundary: manifests + endpoints + tokens only.
 *
 * Failure semantics: any single failed extension is skipped with a warning —
 * extension infrastructure must never take the gateway down. The dual-track
 * design keeps in-process providers fully functional regardless.
 */

import { buildRemoteProviders } from '../protocol/extension/remote-provider.js'
import type { ProviderRegistry } from '../core/registry/provider-registry.js'
import type { ServiceContext } from '../service/context.js'
import { modelIdOf } from '../core/naming.js'

export interface ManagerEndpoint {
  managerUrl: string
  managerToken: string
}

interface RegistrationPackageDto {
  manifest: Parameters<typeof buildRemoteProviders>[0]['manifest']
  endpointUrl: string
  token: string
}

/** Returns the number of remote providers registered. */
export interface RegisterRemoteOptions {
  /**
   * When true, a failed per-extension registration (unreachable manager,
   * bad registration package) makes the whole call throw instead of being
   * skipped with a warning. The post-upgrade re-registration path MUST use
   * this — a silent skip would leave Core holding the pre-rotation token.
   */
  strict?: boolean
}

export async function registerRemoteExtensions(
  ctx: Pick<ServiceContext, 'store' | 'registry'>,
  endpoint: ManagerEndpoint,
  fetchImpl: typeof fetch = fetch,
  opts: RegisterRemoteOptions = {},
): Promise<number> {
  const headers = { authorization: `Bearer ${endpoint.managerToken}` }
  const res = await fetchImpl(`${endpoint.managerUrl}/api/extensions/available`, { headers })
  if (!res.ok) throw new Error(`manager /available -> ${res.status}`)
  const { extensions } = await res.json() as { extensions: Array<{ extensionId: string; status: string }> }
  const installed = extensions.filter((e) => e.status === 'installed')

  let count = 0
  /** Per-extension failure summaries surfaced to callers that need strictness
   *  (post-upgrade re-registration must not silently keep a stale token). */
  const failures: string[] = []
  for (const rec of installed) {
    try {
      const regRes = await fetchImpl(`${endpoint.managerUrl}/api/extensions/${rec.extensionId}/registration`, { headers })
      if (!regRes.ok) throw new Error(`/registration -> ${regRes.status}`)
      const pkg = await regRes.json() as RegistrationPackageDto
      const providers = buildRemoteProviders({
        manifest: pkg.manifest,
        endpoints: { baseUrl: pkg.endpointUrl, token: pkg.token },
      })
      for (const provider of providers) {
        // Extension upgrades rotate the extension token: an already-mounted
        // provider must be replaced in place, not skipped (a skip would leave
        // the old token live until the next gateway restart).
        ctx.registry.replace(provider)
        count++
      }
      // persist provider rows (accounts.provider FK) and seed fallback models
      ctx.store.upsertProviders(providers.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        capabilitiesJson: JSON.stringify(p.capabilities),
      })))
      for (const p of pkg.manifest.providers) {
        for (const m of p.fallbackModels ?? []) {
          ctx.store.upsertModels([{
            modelId: modelIdOf(p.id, m.id),
            provider: p.id,
            upstreamModel: m.id,
            name: m.name,
            capabilities: {
              vision: m.capabilities?.vision ?? false,
              toolCall: m.capabilities?.toolCall ?? false,
              streaming: m.capabilities?.streaming ?? true,
              reasoningEfforts: m.capabilities?.reasoningEfforts,
            },
            enabled: true,
            priority: 0,
            metadataJson: null,
          }])
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push(`${rec.extensionId}: ${message}`)
      console.warn(`[extensions] registration of "${rec.extensionId}" skipped: ${message}`)
    }
  }
  if (opts.strict && failures.length > 0) {
    throw new Error(`remote re-registration failed for: ${failures.join('; ')}`)
  }
  return count
}
