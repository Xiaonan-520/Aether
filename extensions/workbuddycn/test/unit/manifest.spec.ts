/**
 * Manifest compatibility tests — the WorkBuddyCN manifest must satisfy the
 * Phase 3 schema and every Manager runtime constraint, verified locally.
 */
import { describe, expect, it } from 'vitest'
import { MANIFEST, FALLBACK_MODELS } from '../../src/protocol/manifest.js'
import { validateManifest } from '../../src/protocol/validate-manifest.js'

describe('manifest compatibility', () => {
  it('passes the local validator with zero errors and zero violations', () => {
    const r = validateManifest(MANIFEST)
    expect(r.errors).toEqual([])
    expect(r.violations).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('declares apiVersion 1.0 and a semver extension version', () => {
    expect(MANIFEST.apiVersion).toBe('1.0')
    expect(MANIFEST.extension.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(MANIFEST.extension.id).toBe('workbuddycn')
  })

  it('manifest version matches package.json version (version==imageTag invariant)', async () => {
    const pkg = await import('../../package.json', { with: { type: 'json' } })
    expect(MANIFEST.extension.version).toBe(pkg.default.version)
  })

  it('declares runtime port + healthPath + /data volume within Manager limits', () => {
    expect(MANIFEST.runtime.port).toBe(8080)
    expect(MANIFEST.runtime.healthPath).toBe('/health')
    const vol = MANIFEST.runtime.volumes?.find((v) => v.mountPath === '/data')
    expect(vol).toBeDefined()
    expect(vol!.name).toBe('state')
    // Manager ceilings: <=512Mi memory, <=1 cpu.
    expect(MANIFEST.runtime.resources?.memory).toBe('256Mi')
    expect(MANIFEST.runtime.resources?.cpus).toBe('0.5')
  })

  it('declares no privileged intent and named-volumes-only filesystem', () => {
    const perms = MANIFEST.security?.permissions
    expect(perms?.privileged).toBe(false)
    expect(perms?.filesystem).toBe('named-volumes-only')
  })

  it('declares exactly one provider "workbuddycn" with full capabilities', () => {
    expect(MANIFEST.providers).toHaveLength(1)
    const p = MANIFEST.providers[0]!
    expect(p.id).toBe('workbuddycn')
    expect(p.capabilities.loginMode).toBe('external-link')
    expect(p.capabilities.needsCaptcha).toBe(false)
    expect(p.capabilities.supportsQuota).toBe(true)
    expect(p.capabilities.supportsStreaming).toBe(true)
  })

  it('fallback model ids carry no provider prefix and are unique', () => {
    const ids = FALLBACK_MODELS.map((m) => m.id)
    expect(ids.every((id) => !id.includes('::'))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('deepseek-v4-flash')
  })

  it('declares only the read-only refresh-quota action and no authAction (pure external-link login)', () => {
    const p = MANIFEST.providers[0]!
    expect(p.actions.map((a) => a.id)).toEqual(['refresh-quota'])
    expect(p.authAction).toBeUndefined()
  })

  it('rejects a manifest with privileged: true', () => {
    const bad = structuredClone(MANIFEST) as Record<string, unknown>
    ;(bad.security as Record<string, unknown>).permissions = { privileged: true }
    expect(validateManifest(bad).violations.some((v) => v.path.includes('privileged'))).toBe(true)
  })

  it('rejects a reserved mount path', () => {
    const bad = structuredClone(MANIFEST) as Record<string, unknown>
    ;((bad.runtime as Record<string, unknown>).volumes as Array<Record<string, unknown>>)[0]!.mountPath = '/var/run/docker.sock'
    expect(validateManifest(bad).violations.some((v) => v.path.includes('mountPath'))).toBe(true)
  })

  it('rejects a needsCaptcha provider with no write action', () => {
    const bad = structuredClone(MANIFEST) as Record<string, unknown>
    const caps = (bad.providers as Array<Record<string, unknown>>)[0]!.capabilities as Record<string, unknown>
    caps.needsCaptcha = true
    expect(validateManifest(bad).violations.some((v) => v.path.includes('actions'))).toBe(true)
  })
})
