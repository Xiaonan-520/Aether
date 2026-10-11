#!/usr/bin/env node
/**
 * Ensure better-sqlite3's native binding is available for the current runtime.
 * Falls back gracefully if no compiler/prebuild is available. Used as a
 * postinstall hook and inside the Docker build.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const modDir = new URL('../node_modules/better-sqlite3', import.meta.url).pathname

// Quick self-test: can we already load the module?
try {
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  db.exec('select 1')
  db.close()
  process.stdout.write('better-sqlite3 native binding is ready.\n')
  process.exit(0)
} catch {
  // fall through to build
}

process.stdout.write('Rebuilding better-sqlite3 native binding...\n')

// Try prebuild-install then node-gyp rebuild.
let ok = false
let result = spawnSync('npx', ['--no-install', 'prebuild-install', '--runtime', 'node', '--arch', process.arch], {
  cwd: modDir,
  stdio: 'inherit',
})
ok = result.status === 0
if (!ok) {
  result = spawnSync('npx', ['--no-install', 'node-gyp', 'rebuild'], {
    cwd: modDir,
    stdio: 'inherit',
  })
  ok = result.status === 0
}

if (!ok) {
  process.stderr.write('warning: could not build better-sqlite3 native binding; SQLite persistence unavailable.\n')
  process.exit(0)
}
process.stdout.write('better-sqlite3 rebuilt.\n')
process.exit(0)