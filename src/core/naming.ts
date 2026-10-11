/**
 * Model naming convention (single source of truth).
 *
 * Public model ids are namespaced `provider::upstream`; the bare upstream id
 * stays in `upstreamModel` and is the ONLY string sent upstream. Every model
 * row constructor — built-in adapters, remote extension mounting and the
 * bootstrap fallback seeding — must build ids through this helper so the rule
 * cannot drift between call sites.
 */
export function modelIdOf(provider: string, upstreamModel: string): string {
  return `${provider}::${upstreamModel}`
}
