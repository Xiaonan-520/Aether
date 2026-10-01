/**
 * Cline model catalog.
 *
 * Two sources, merged (verified reference):
 * - `GET /api/v1/models` (auth) lists ~460 ids but contains NO `cline-free/*`;
 * - `GET /api/v1/ai/cline/recommended-models` (no auth) is the only authoritative
 *   source of the `free` set.
 *
 * Free membership is therefore: remote `free` ids ∪ `*:free` suffix ∪
 * `cline-free/` prefix. Nothing is hardcoded as free.
 */
export interface ClineModel {
  id: string
  name: string
  isFree: boolean
}

const FREE_ID_SUFFIX = ':free'
const FREE_ID_PREFIX = 'cline-free/'

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Extract ids from any of the array shapes the two endpoints use. */
function idsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) ids.push(item)
    else if (typeof item === 'object' && item !== null) {
      const id = readString(item as Record<string, unknown>, ['id', 'model', 'modelId'])
      if (id) ids.push(id)
    }
  }
  return ids
}

export interface ClineCatalogSources {
  /** `GET /api/v1/models` body */
  allModels?: unknown
  /** `GET /api/v1/ai/cline/recommended-models` body */
  recommended?: unknown
}

/** Free ids advertised by `recommended-models` (`{data:{free:[…]}}`). */
export function parseClineFreeIds(recommended: unknown): string[] {
  if (typeof recommended !== 'object' || recommended === null) return []
  const root = recommended as Record<string, unknown>
  const inner = typeof root.data === 'object' && root.data !== null ? (root.data as Record<string, unknown>) : root
  return idsFrom(inner.free)
}

/** Every id from `GET /api/v1/models` (accepts `{data:[…]}` or a bare array). */
export function parseClineAllModelIds(allModels: unknown): string[] {
  if (Array.isArray(allModels)) return idsFrom(allModels)
  if (typeof allModels !== 'object' || allModels === null) return []
  const root = allModels as Record<string, unknown>
  if (Array.isArray(root.data)) return idsFrom(root.data)
  if (typeof root.data === 'object' && root.data !== null) {
    const inner = root.data as Record<string, unknown>
    return [...idsFrom(inner.models), ...idsFrom(inner.data)]
  }
  return [...idsFrom(root.models), ...idsFrom(root.data)]
}

/** isFree(id) = in the remote free set, or a `:free` suffix / `cline-free/` prefix. */
export function isClineFreeModel(id: string, remoteFreeIds: ReadonlySet<string>): boolean {
  return remoteFreeIds.has(id) || id.endsWith(FREE_ID_SUFFIX) || id.startsWith(FREE_ID_PREFIX)
}

/** Merge both sources into a de-duplicated catalog with free membership marked. */
export function buildClineCatalog(sources: ClineCatalogSources): ClineModel[] {
  const remoteFree = new Set(parseClineFreeIds(sources.recommended))
  const ids = new Set<string>([...parseClineAllModelIds(sources.allModels), ...remoteFree])
  return [...ids]
    .map((id) => ({ id, name: id, isFree: isClineFreeModel(id, remoteFree) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
