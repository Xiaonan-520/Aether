/**
 * Automatic recovery from Core↔Extension token desync.
 *
 * Background (verified against the source, not assumed from symptoms):
 *
 *   - The Extension Manager owns the token. `runInstallPipeline` mints a FRESH
 *     token on every install/upgrade/rollback (`issueToken()`), seals it in the
 *     manager store, and injects it into the new container as
 *     `GATEWAY_EXTENSION_TOKEN`.
 *   - Core only learns tokens through `registerRemoteExtensions()`, which is
 *     called exactly once at boot (`src/http/index.ts`) and again on the
 *     explicit `/api/console/extensions/:id/{upgrade,reload}` admin routes.
 *   - The Manager never notifies Core. There is no callback and no event.
 *
 * So after a Manager-side upgrade the extension container already uses the new
 * token while Core still holds the old one — a permanent 401 until someone calls
 * `reload`. Worse, that 401 used to be reported as `AUTH_INVALID`, which the
 * account pool interprets as "this account's provider credential is dead" and
 * parks in `token_expired`.
 *
 * This module closes the gap without a new token store and without restarting
 * the gateway:
 *
 *   - Extensions now answer a bad hop credential with `EXTENSION_AUTH`
 *     (see `protocol/extension/errors.ts`), which is NOT an account problem.
 *   - On such a failure Core re-pulls the registration package from the Manager
 *     (the authoritative source), re-mounts the provider via
 *     `registry.replace()` (idempotent by provider id) and retries the request
 *     exactly once.
 *
 * Safety properties:
 *   - bounded: a single retry, plus a per-extension cooldown so a genuinely
 *     broken hop cannot cause a request storm;
 *   - no credentials moved: Core never stores the token itself, it asks the
 *     Manager for the sealed package each time;
 *   - no stale overwrite: the package always comes from the Manager, so an old
 *     token can never beat a confirmed new one;
 *   - concurrent-safe: refresh is deduplicated per extension id via an
 *     in-flight promise map;
 *   - failure is surfaced, not swallowed: callers see the original error if the
 *     refresh could not produce a working registration.
 */

import { buildRemoteProviders } from './remote-provider.js'
import { isExtensionAuthFailure, type ExtensionErrorBody } from './errors.js'
import type { ProviderRegistry } from '../../core/registry/provider-registry.js'
import type { ServiceContext } from '../../service/context.js'

export interface ManagerRegistrationSource {
  managerUrl: string
  managerToken: string
}

interface RegistrationPackageDto {
  manifest: Parameters<typeof buildRemoteProviders>[0]['manifest']
  endpointUrl: string
  token: string
}

/** Minimum spacing between refresh attempts for the same extension. */
const DEFAULT_COOLDOWN_MS = 5_000

/**
 * Tracks in-flight refreshes (one per extension id) and a short cooldown after
 * a failed attempt, so a broken hop degrades into a fast error instead of a
 * retry storm.
 */
export class ExtensionAuthRecovery {
  private readonly inFlight = new Map<string, Promise<boolean>>()
  private readonly lastAttempt = new Map<string, number>()
  private readonly lastFailure = new Map<string, string>()

  constructor(
    private readonly ctx: Pick<ServiceContext, 'store' | 'registry' | 'now'>,
    private readonly source: ManagerRegistrationSource | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly cooldownMs: number = DEFAULT_COOLDOWN_MS,
  ) {}

  /** True when the error body reports a Core↔Extension credential mismatch. */
  static isAuthMismatch(body: unknown): boolean {
    if (!body || typeof body !== 'object') return false
    const e = (body as ExtensionErrorBody).error
    return Boolean(e) && isExtensionAuthFailure(body as ExtensionErrorBody)
  }

  /** Diagnostics snapshot (no tokens — only ids, outcomes and timestamps). */
  snapshot(): Array<{ extensionId: string; lastAttemptAt: number | null; lastFailure: string | null }> {
    const ids = new Set([...this.lastAttempt.keys(), ...this.lastFailure.keys()])
    return [...ids].map((extensionId) => ({
      extensionId,
      lastAttemptAt: this.lastAttempt.get(extensionId) ?? null,
      lastFailure: this.lastFailure.get(extensionId) ?? null,
    }))
  }

  /**
   * Re-pull `extensionId`'s registration package from the Manager and replace
   * its remote providers in the registry.
   *
   * @returns true when the refresh produced a mounted provider
   */
  async refresh(extensionId: string): Promise<boolean> {
    if (!this.source) return false
    const running = this.inFlight.get(extensionId)
    if (running) return running

    // Cooldown guards against a request storm when the hop is genuinely broken.
    const last = this.lastAttempt.get(extensionId)
    const now = this.ctx.now()
    if (last !== undefined && now - last < this.cooldownMs && this.lastFailure.has(extensionId)) {
      return false
    }

    const attempt = this.doRefresh(extensionId).finally(() => {
      this.inFlight.delete(extensionId)
    })
    this.inFlight.set(extensionId, attempt)
    return attempt
  }

  private async doRefresh(extensionId: string): Promise<boolean> {
    this.lastAttempt.set(extensionId, this.ctx.now())
    const headers = { authorization: `Bearer ${this.source!.managerToken}` }
    try {
      const res = await this.fetchImpl(
        `${this.source!.managerUrl}/api/extensions/${extensionId}/registration`,
        { headers },
      )
      if (!res.ok) throw new Error(`manager /registration -> ${res.status}`)
      const pkg = (await res.json()) as RegistrationPackageDto
      const providers = buildRemoteProviders({
        manifest: pkg.manifest,
        endpoints: { baseUrl: pkg.endpointUrl, token: pkg.token },
      })
      for (const provider of providers) {
        // replace() is idempotent by provider id: a rotation updates the token in
        // place and never double-mounts a second provider.
        this.ctx.registry.replace(provider)
      }
      this.ctx.store.upsertProviders(
        providers.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          capabilitiesJson: JSON.stringify(p.capabilities),
        })),
      )
      this.lastFailure.delete(extensionId)
      this.ctx.store.addEvent({
        ts: this.ctx.now(),
        level: 'info',
        provider: extensionId,
        kind: 'extension.token_refreshed',
        message: `re-registered "${extensionId}" after an extension-auth mismatch`,
      })
      return providers.length > 0
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.lastFailure.set(extensionId, reason)
      // Loud but bounded: the operator sees exactly which hop is broken and why.
      console.warn(`[extensions] auth-refresh for "${extensionId}" failed: ${reason}`)
      this.ctx.store.addEvent({
        ts: this.ctx.now(),
        level: 'warn',
        provider: extensionId,
        kind: 'extension.token_refresh_failed',
        message: `auth-refresh failed: ${reason}`,
      })
      return false
    }
  }
}

/**
 * Resolve the extension id that owns a provider id.
 *
 * Remote provider ids come straight from the manifest's `providers[].id`, and
 * an extension may expose several (the codebuddy image serves both `codebuddy`
 * and `buddy-intl`). The manager is the only authority, so this is a best-effort
 * lookup used solely to choose which registration package to re-pull; a miss
 * simply means no automatic refresh.
 */
export async function resolveExtensionIdForProvider(
  source: ManagerRegistrationSource,
  providerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${source.managerUrl}/api/extensions/available`, {
      headers: { authorization: `Bearer ${source.managerToken}` },
    })
    if (!res.ok) return undefined
    const { extensions } = (await res.json()) as {
      extensions: Array<{ extensionId: string; status: string }>
    }
    const installed = extensions.filter((e) => e.status === 'installed')
    for (const rec of installed) {
      // The registration package is the only place provider→extension is stated.
      const pkgRes = await fetchImpl(
        `${source.managerUrl}/api/extensions/${rec.extensionId}/registration`,
        { headers: { authorization: `Bearer ${source.managerToken}` } },
      )
      if (!pkgRes.ok) continue
      const pkg = (await pkgRes.json()) as RegistrationPackageDto
      if (pkg.manifest.providers.some((p) => p.id === providerId)) return rec.extensionId
    }
    return undefined
  } catch {
    return undefined
  }
}
