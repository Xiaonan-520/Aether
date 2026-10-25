/**
 * Deploy-script static contract tests.
 *
 * The real deploy path needs a Docker daemon and a live container, which CI
 * does not have. These tests pin the safety properties that make the script
 * trustworthy: it must reject non-immutable tags, verify the image revision
 * label, only update one service, and roll back on failure.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'deploy-core.sh')
const source = readFileSync(SCRIPT, 'utf8')

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HEALTH_TIMEOUT_S: '1' },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('deploy-core.sh — safety contract', () => {
  it('is executable and passes bash syntax checking', () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0)
    expect(() => execFileSync('bash', ['-n', SCRIPT], { stdio: 'pipe' })).not.toThrow()
  })

  it('rejects a moving tag instead of deploying latest', () => {
    const result = run(['latest'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('full 40-character')
  })

  it('rejects a short SHA', () => {
    const result = run(['d452397'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('full 40-character')
  })

  it('rejects a missing argument', () => {
    const result = run([])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('missing commit SHA')
  })

  it('requires a full commit tag for the running image before deploying', () => {
    expect(source).toContain('is not pinned to a commit tag')
  })

  it('verifies the image revision label matches the requested commit', () => {
    expect(source).toContain('org.opencontainers.image.revision')
    expect(source).toContain('does not match requested commit')
  })

  it('only updates the gateway service without recreating dependencies', () => {
    expect(source).toContain('up -d --no-deps --no-build')
    expect(source).toContain('GATEWAY_IMAGE_TAG="sha-$COMMIT"')
  })

  it('never runs compose down, prune, or volume removal', () => {
    // strip comments: the header explains what the script deliberately avoids
    const executable = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    for (const forbidden of ['compose down', 'docker system prune', 'docker volume rm', 'docker rm -f']) {
      expect(executable).not.toContain(forbidden)
    }
  })

  it('records the previous image and rolls back automatically', () => {
    expect(source).toContain('PREVIOUS_IMAGE')
    expect(source).toContain('restore_previous')
    expect(source).toContain('rolling back')
  })

  it('verifies health by container state and /healthz', () => {
    expect(source).toContain('wait_healthy')
    expect(source).toContain('wait_http_healthy')
    expect(source).toContain('/healthz')
  })

  it('supports a dry run that changes nothing', () => {
    expect(source).toContain('--dry-run')
    expect(source).toContain('dry-run: would wait for healthy')
  })

  it('prints digest, revision and start time for verification', () => {
    expect(source).toContain('--digest')
    expect(source).toContain('repo_digest=')
    expect(source).toContain('started_at=')
  })
})
