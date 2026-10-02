/**
 * Copy non-TypeScript runtime assets into dist/.
 *
 * `tsc` only emits JS, so runtime assets would be missing from the runtime
 * image. The list is explicit; a missing asset is a warning, not an error —
 * the Qoder WASM is optional by design (see src/providers/qoder/wasm.ts).
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = [
  // Optional: operators may drop their own qoder-auth-wasm.wasm here.
  ['src/providers/qoder/qoder-auth-wasm.wasm', 'dist/providers/qoder/qoder-auth-wasm.wasm'],
]

let failed = false
for (const [from, to] of assets) {
  const source = resolve(root, from)
  if (!existsSync(source)) {
    console.warn(`copy-assets: optional asset absent, skipping: ${from}`)
    continue
  }
  const target = resolve(root, to)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  console.log(`copy-assets: ${from} -> ${to}`)
}
if (failed) process.exit(1)
