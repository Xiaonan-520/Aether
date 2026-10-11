/**
 * Phase 1 contract tests: namespace, manifest validation, quota projection.
 * (§22.1 conformance skeleton is exercised in extension-conformance.spec.ts.)
 */
import { describe, expect, it } from 'vitest'
import {
  isValidIdentifier,
  splitPublicModelKey,
  toPublicModelKey,
} from '../src/protocol/extension/namespace.js'
import {
  isSupportedApiVersion,
  validateManifest,
} from '../src/protocol/extension/validate-manifest.js'
import { quotaSnapshotV1ToLegacy } from '../src/protocol/extension/remote-provider.js'
import type { QuotaSnapshotV1 } from '../src/protocol/extension/accounts.js'
import {
  buddyManifestFixture,
  zcodeManifestFixture,
} from './fixtures/extension-manifests.js'

describe('namespace (RFC §9.1)', () => {
  it('identifiers are lowercase [a-z0-9-]', () => {
    expect(isValidIdentifier('buddy')).toBe(true)
    expect(isValidIdentifier('workbuddy-cn')).toBe(true)
    expect(isValidIdentifier('Buddy')).toBe(false)
    expect(isValidIdentifier('has space')).toBe(false)
    expect(isValidIdentifier('-lead')).toBe(false)
    expect(isValidIdentifier('')).toBe(false)
  })

  it('provider::model round-trips; bare model returns null', () => {
    expect(toPublicModelKey('workbuddy', 'glm-4.7')).toBe('workbuddy::glm-4.7')
    expect(splitPublicModelKey('workbuddy::glm-4.7')).toEqual({ providerId: 'workbuddy', modelId: 'glm-4.7' })
    expect(splitPublicModelKey('glm-4.7')).toBeNull()
  })

  it('extension_id and provider_id are independent types (buddy ≠ workbuddy)', () => {
    // compile-level guarantee: both are distinct branded strings; here we
    // assert the fixtures express the multi-provider mapping
    expect(buddyManifestFixture.extension.id).toBe('buddy')
    expect(buddyManifestFixture.providers.map((p) => p.id)).toEqual([
      'workbuddy', 'workbuddy-cn', 'codebuddy', 'buddy-intl',
    ])
  })
})

describe('manifest validation (RFC §12)', () => {
  it('accepts the canonical zcode and buddy fixtures', () => {
    expect(validateManifest(structuredClone(zcodeManifestFixture)).ok).toBe(true)
    expect(validateManifest(structuredClone(buddyManifestFixture)).ok).toBe(true)
  })

  it('rejects unsupported apiVersion majors', () => {
    const m = structuredClone(zcodeManifestFixture)
    m.apiVersion = '2.0'
    const res = validateManifest(m)
    expect(res.ok).toBe(false)
    expect(res.violations.some((v) => v.path === 'apiVersion')).toBe(true)
  })

  it('isSupportedApiVersion accepts current major only', () => {
    expect(isSupportedApiVersion('1.0')).toBe(true)
    expect(isSupportedApiVersion('1.9')).toBe(true)
    expect(isSupportedApiVersion('2.0')).toBe(false)
    expect(isSupportedApiVersion('junk')).toBe(false)
  })

  it('rejects duplicate provider ids across the manifest', () => {
    const m = structuredClone(buddyManifestFixture)
    m.providers[1].id = 'workbuddy' // collide with providers[0]
    const res = validateManifest(m)
    expect(res.ok).toBe(false)
    expect(res.violations.some((v) => v.message.includes('duplicate provider id'))).toBe(true)
  })

  it('rejects hostPath / docker.sock / privileged intents (manifest ≠ Docker API)', () => {
    const sock = structuredClone(zcodeManifestFixture)
    sock.runtime.volumes!.push({ name: 'docker', mountPath: '/var/run/docker.sock' })
    expect(validateManifest(sock).violations.some((v) => v.message.includes('reserved host path'))).toBe(true)

    const priv = structuredClone(zcodeManifestFixture)
    priv.security!.permissions!.privileged = true
    expect(validateManifest(priv).violations.some((v) => v.path === 'security.permissions.privileged')).toBe(true)
  })

  it('rejects invalid action declarations (missing mode/sideEffects, bad schema type)', () => {
    const m = structuredClone(zcodeManifestFixture)
    // @ts-expect-error — deliberately broken fixture
    delete m.providers[0].actions![1].mode
    const res = validateManifest(m)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.path.includes('actions') && e.message.includes('Required'))).toBe(true)

    const badSchema = structuredClone(zcodeManifestFixture)
    badSchema.providers[0].actions![1].inputSchema = { type: 'nonsense' }
    expect(validateManifest(badSchema).errors.some((e) => e.message.includes('known JSON Schema type'))).toBe(true)
  })

  it('needsCaptcha providers must declare a submit-capable action (no solver by construction)', () => {
    const m = structuredClone(zcodeManifestFixture)
    m.providers[0].actions = m.providers[0].actions!.slice(0, 1) // keep widget, drop submit
    const res = validateManifest(m)
    expect(res.ok).toBe(false)
    expect(res.violations.some((v) => v.message.includes('official widget'))).toBe(true)
  })

  it('distribution.image must be a GHCR gateway-extension repo', () => {
    const m = structuredClone(zcodeManifestFixture)
    m.distribution!.image = 'docker.io/library/nginx'
    const res = validateManifest(m)
    expect(res.ok).toBe(false)
    expect(res.violations.some((v) => v.path === 'distribution.image')).toBe(true)
  })

  it('rejects unknown top-level fields (strict manifest)', () => {
    const m: Record<string, unknown> = structuredClone(zcodeManifestFixture)
    m.docker = { privileged: true } // an attempt to smuggle a Docker API
    const res = validateManifest(m)
    expect(res.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
  })
})

describe('quota projection (RFC §13)', () => {
  const snap = (resources: QuotaSnapshotV1['resources']): QuotaSnapshotV1 => ({
    accountId: 'workbuddy-01',
    resources,
    checkedAt: '2026-10-03T09:30:00Z',
    source: 'authoritative',
  })

  it('empty resources → unknown (never invent numbers)', () => {
    expect(quotaSnapshotV1ToLegacy(snap([]))).toEqual({ known: false, remaining: null, total: null, resetAt: null })
    expect(quotaSnapshotV1ToLegacy(null)).toEqual({ known: false, remaining: null, total: null, resetAt: null })
  })

  it('picks the scarcest routable resource; custom resources never gate routing', () => {
    const v1 = snap([
      { id: 'gift_credits', kind: 'credits', remaining: 20, total: 20, used: 0, unit: 'credits', resetAt: '2026-10-04T00:00:00+08:00', status: 'ok' },
      { id: 'plan_quota', kind: 'subscription', remaining: 64, total: 1000, used: 936, unit: 'requests', resetAt: '2026-11-01T00:00:00+08:00', status: 'low' },
      { id: 'cash_balance', kind: 'custom', remaining: 0, total: null, used: null, unit: 'CNY', resetAt: null, status: 'ok' },
    ])
    const legacy = quotaSnapshotV1ToLegacy(v1)
    expect(legacy.known).toBe(true)
    expect(legacy.remaining).toBe(64)
    expect(legacy.total).toBe(1000)
    expect(legacy.resetAt).toBe(Date.parse('2026-11-01T00:00:00+08:00'))
  })

  it('resources with unknown remaining are ignored', () => {
    const v1 = snap([
      { id: 'mystery', kind: 'custom', remaining: null, total: null, used: null, unit: 'raw', resetAt: null, status: 'unknown' },
    ])
    expect(quotaSnapshotV1ToLegacy(v1).known).toBe(false)
  })
})
