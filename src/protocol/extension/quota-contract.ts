/**
 * Quota contract validation (§13.1, §13.2).
 *
 * Core validates a live QuotaSnapshotV1 against the extension's manifest
 * declaration (QuotaResourceDeclaration[]). Validation NEVER invents data:
 * missing fields stay missing, unknown resource ids are reported, and a
 * failed validation still lets the snapshot through (rawJson preserved for
 * diagnostics) — the result records what was off so the UI can annotate it.
 */

import type { QuotaResourceDeclaration, QuotaSnapshotV1 } from './accounts.js'

export interface QuotaContractIssue {
  /** machine-readable path, e.g. `resources[2].remaining` */
  path: string
  message: string
  severity: 'undeclared-resource' | 'missing-declared-field' | 'undeclared-field' | 'type-mismatch' | 'missing-declaration'
}

export interface QuotaContractResult {
  /** true when the snapshot fully conforms (or no declaration exists) */
  ok: boolean
  issues: QuotaContractIssue[]
}

/**
 * Validate a live snapshot against the declaration. Semantics:
 *
 *  - no declaration at all (older extensions): `ok: true` with a single
 *    `missing-declaration` note — the snapshot is trusted as-is (back-compat);
 *  - declared resources not present in the snapshot: `missing-declared-field`
 *    on the declaration id (upstream may legitimately omit, e.g. exhausted
 *    packages disappear) — surfaced, never fabricated;
 *  - snapshot resources not declared: `undeclared-resource` — still rendered,
 *    but flagged so extension authors fix the manifest;
 *  - declared-optional numeric fields present but of the wrong type:
 *    `type-mismatch`.
 */
export function validateQuotaSnapshotAgainstDeclaration(
  snapshot: QuotaSnapshotV1,
  providerId: string,
  declaration: QuotaResourceDeclaration[] | undefined,
): QuotaContractResult {
  const issues: QuotaContractIssue[] = []

  if (!declaration || declaration.length === 0) {
    return {
      ok: true,
      issues: snapshot.resources.length > 0
        ? [{
            path: 'resources',
            message: `provider "${providerId}" returned quota resources without a manifest quotaResources declaration (legacy extension)`,
            severity: 'missing-declaration',
          }]
        : [],
    }
  }

  const declaredById = new Map(declaration.map((d) => [d.id, d]))
  const snapshotIds = new Set(snapshot.resources.map((r) => r.id))

  // wildcard declarations: an id ending in `*` declares a FAMILY of
  // per-instance resources (e.g. `pkg-*` for per-package meter lines).
  // Matching is prefix-based against the concrete snapshot id.
  const matchDeclaration = (resourceId: string): QuotaResourceDeclaration | undefined => {
    const exact = declaredById.get(resourceId)
    if (exact) return exact
    for (const d of declaration) {
      if (d.id.endsWith('*') && resourceId.startsWith(d.id.slice(0, -1))) return d
    }
    return undefined
  }
  const hasWildcard = declaration.some((d) => d.id.endsWith('*'))

  for (const d of declaration) {
    // wildcard declarations match a family — they are never "absent" as such
    if (d.id.endsWith('*')) continue
    if (!snapshotIds.has(d.id)) {
      issues.push({
        path: `resources.${d.id}`,
        message: `declared quota resource "${d.id}" absent from the snapshot (upstream may have omitted it)`,
        severity: 'missing-declared-field',
      })
    }
  }
  // a wildcard-only declaration with an empty snapshot is legitimately "no
  // packages right now" — not a violation (the snapshot itself carries the
  // state; the Console renders known:false).

  for (const r of snapshot.resources) {
    const d = matchDeclaration(r.id)
    if (!d) {
      issues.push({
        path: `resources.${r.id}`,
        message: `snapshot resource "${r.id}" is not declared in the manifest quotaResources`,
        severity: 'undeclared-resource',
      })
      continue
    }
    if (d.unit !== undefined && r.unit !== d.unit) {
      issues.push({
        path: `resources.${r.id}.unit`,
        message: `unit mismatch: declared "${d.unit}", snapshot says "${r.unit}"`,
        severity: 'type-mismatch',
      })
    }
    for (const field of ['remaining', 'total', 'used'] as const) {
      const value = r[field]
      if (value !== null && value !== undefined && typeof value !== 'number') {
        issues.push({
          path: `resources.${r.id}.${field}`,
          message: `${field} must be a number or null, got ${typeof value}`,
          severity: 'type-mismatch',
        })
      }
    }
    if (r.resetAt !== null && r.resetAt !== undefined && typeof r.resetAt !== 'string') {
      issues.push({
        path: `resources.${r.id}.resetAt`,
        message: `resetAt must be an ISO string or null`,
        severity: 'type-mismatch',
      })
    }
  }

  return { ok: issues.every((i) => i.severity === 'missing-declaration'), issues }
}
