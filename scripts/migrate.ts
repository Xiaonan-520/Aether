/**
 * Migration CLI: `npm run migrate` creates/updates the SQLite schema at
 * DATA_DIR/gateway.db (default ./data/gateway.db).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config/index.js'
import { openSqliteStore } from '../src/store/sqlite/sqlite-store.js'

const cfg = loadConfig()
mkdirSync(cfg.dataDir, { recursive: true })
const dbPath = join(cfg.dataDir, 'gateway.db')
const store = await openSqliteStore(dbPath)
if (!store) {
  console.error('better-sqlite3 is not available; cannot run migrations')
  process.exit(1)
}
console.log(`migrations applied at ${dbPath}`)
store.close()
