/**
 * Copy non-TypeScript runtime assets into dist/.
 *
 * `tsc` only emits JS, so the vendored Qoder WASM would be missing from the
 * runtime image. This keeps the asset list explicit and fails loudly if a
 * source asset disappears.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = [['src/providers/qoder/qoder-auth-wasm.wasm', 'dist/providers/qoder/qoder-auth-wasm.wasm']]

let failed = false
for (const [from, to] of assets) {
  const source = resolve(root, from)
  if (!existsSync(source)) {
    console.error(`copy-assets: missing source asset ${from}`)
    failed = true
    continue
  }
  const target = resolve(root, to)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  console.log(`copy-assets: ${from} -> ${to}`)
}
if (failed) process.exit(1)
