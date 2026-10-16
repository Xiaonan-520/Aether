/**
 * Declarative quota contract tests (§13.1): manifest declaration validation,
 * live-snapshot conformance, back-compat with undeclared (legacy) extensions,
 * and the Console-side V1 parsing fix.
 */
import { describe, expect, it } from 'vitest'
import {
  validateQuotaSnapshotAgainstDeclaration,
  type QuotaContractIssue,
} from '../src/protocol/extension/quota-contract.js'
import type { QuotaResourceDeclaration, QuotaSnapshotV1 } from '../src/protocol/extension/accounts.js'
import { validateManifest } from '../src/protocol/extension/validate-manifest.js'

const decl: QuotaResourceDeclaration[] = [
  { id: 'credits', kind: 'credits', unit: 'credits', displayName: 'Bonus credits', fields: { remaining: true, total: true, resetAt: true } },
]

const snapshotOf = (resources: QuotaSnapshotV1['resources']): QuotaSnapshotV1 => ({
  accountId: 'acc-1',
  resources,
  checkedAt: new Date().toISOString(),
  source: 'authoritative',
})

describe('quota contract: snapshot vs declaration', () => {
  it('fully conforming snapshot passes', () => {
    const r = validateQuotaSnapshotAgainstDeclaration(snapshotOf([
      { id: 'credits', kind: 'credits', remaining: 84.15, total: 84.15, used: 0, unit: 'credits', resetAt: '2026-10-31T00:00:00Z', status: 'ok' },
    ]), 'workbuddy', decl)
    expect(r.ok).toBe(true)
    expect(r.issues).toEqual([])
  })

  it('undeclared snapshot resource is surfaced, never silently rendered', () => {
    const r = validateQuotaSnapshotAgainstDeclaration(snapshotOf([
      { id: 'mystery_points', kind: 'custom', remaining: 5, total: null, used: null, unit: 'raw', resetAt: null, status: 'unknown' },
    ]), 'workbuddy', decl)
    expect(r.issues.some((i: QuotaContractIssue) => i.severity === 'undeclared-resource' && i.path === 'resources.mystery_points')).toBe(true)
  })

  it('declared resource missing from the snapshot is surfaced, not fabricated', () => {
    const r = validateQuotaSnapshotAgainstDeclaration(snapshotOf([]), 'workbuddy', decl)
    expect(r.issues.some((i) => i.severity === 'missing-declared-field' && i.path === 'resources.credits')).toBe(true)
    // missing data stays missing — no zero-coercion anywhere in the result
    expect(JSON.stringify(r)).not.toContain('"remaining":0')
  })

  it('unit mismatch is a type-mismatch issue', () => {
    const r = validateQuotaSnapshotAgainstDeclaration(snapshotOf([
      { id: 'credits', kind: 'credits', remaining: 1, total: null, used: null, unit: 'USD', resetAt: null, status: 'ok' },
    ]), 'workbuddy', decl)
    expect(r.issues.some((i) => i.severity === 'type-mismatch' && i.path === 'resources.credits.unit')).toBe(true)
  })

  it('non-numeric remaining is a type-mismatch', () => {
    const bad = snapshotOf([
      { id: 'credits', kind: 'credits', remaining: 'many' as unknown as number, total: null, used: null, unit: 'credits', resetAt: null, status: 'unknown' },
    ])
    const r = validateQuotaSnapshotAgainstDeclaration(bad, 'workbuddy', decl)
    expect(r.issues.some((i) => i.severity === 'type-mismatch' && i.path === 'resources.credits.remaining')).toBe(true)
  })

  it('legacy extension without a declaration: snapshot trusted as-is with a note', () => {
    const r = validateQuotaSnapshotAgainstDeclaration(snapshotOf([
      { id: 'credits', kind: 'credits', remaining: 10, total: null, used: null, unit: 'credits', resetAt: null, status: 'ok' },
    ]), 'legacy-ext', undefined)
    expect(r.ok).toBe(true)
    expect(r.issues[0]).toMatchObject({ severity: 'missing-declaration' })
  })

  it('empty snapshot with no declaration: clean pass (nothing to flag)', () => {
    const r = validateQuotaSnapshotAgainstDeclaration(snapshotOf([]), 'legacy-ext', undefined)
    expect(r.ok).toBe(true)
    expect(r.issues).toEqual([])
  })
})

describe('quota contract: manifest validation', () => {
  const baseManifest = () => ({
    apiVersion: '1.0',
    extension: { id: 'qtest', version: '1.0.0', displayName: 'Q', description: '', license: 'MIT' },
    runtime: { port: 8080, healthPath: '/health', env: [], volumes: [] },
    providers: [{
      id: 'q', displayName: 'Q', protocol: 'openai-chat',
      capabilities: {
        supportsOAuth: true, supportsRefreshToken: true, supportsQuota: true, supportsCredits: false,
        supportsStreaming: true, supportsVision: false, supportsToolCall: false,
        supportsMultipleAccounts: true, needsCaptcha: false, loginMode: 'external-link', protocol: 'openai-chat',
      },
      quotaResources: [{ id: 'credits', kind: 'credits', unit: 'credits', fields: { remaining: true } }],
    }],
  })

  it('accepts a manifest with a well-formed quotaResources declaration', () => {
    expect(validateManifest(baseManifest() as never).ok).toBe(true)
  })

  it('rejects an unknown quota kind (closed enum)', () => {
    const m = baseManifest() as never as { providers: Array<{ quotaResources: Array<Record<string, unknown>> }> }
    m.providers[0].quotaResources[0].kind = 'bitcoin'
    const r = validateManifest(m as never)
    expect(r.ok).toBe(false)
  })

  it('rejects unexpected fields in the declaration (strict)', () => {
    const m = baseManifest() as never as { providers: Array<{ quotaResources: Array<Record<string, unknown>> }> }
    m.providers[0].quotaResources[0].balanceHint = 'guess'
    expect(validateManifest(m as never).ok).toBe(false)
  })
})
