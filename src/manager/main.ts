/**
 * Extension Manager standalone entrypoint (deployment form).
 *
 * Runs the manager HTTP API on the manager-internal network. Phase 2 binding
 * policy: without GW_MANAGER_ALLOW_REMOTE the API binds loopback only — the
 * compose file reaches it through the container network (container-local
 * loopback is unreachable from outside, so deployment sets the flag).
 *
 * NEVER expose this service to the internet (RFC v2 §19.5).
 */

import { loadConfig } from '../config/index.js'
import { ExtensionManager, startManagerApi } from './index.js'
import { DockerRuntime } from './docker-api.js'
import { LocalProcessRuntime } from './local-runtime.js'
import { ManagerStore } from './store.js'
import { join } from 'node:path'

// The manager reuses the gateway's GATEWAY_SECRET for registration-token
// sealing but is not a gateway: it needs no API key / admin token. Dummy
// values satisfy loadConfig without weakening anything real.
const config = loadConfig({
  ...process.env,
  GATEWAY_API_KEY: process.env.GATEWAY_API_KEY ?? 'manager-does-not-serve-data-plane',
  GATEWAY_ADMIN_TOKEN: process.env.GATEWAY_ADMIN_TOKEN ?? 'manager-does-not-serve-admin-plane',
})
const token = process.env.GATEWAY_MANAGER_TOKEN
if (!token || token.length < 16) {
  console.error('[manager] GATEWAY_MANAGER_TOKEN must be set (>=16 chars)')
  process.exit(1)
}

const dataDir = process.env.GATEWAY_MANAGER_DB
  ? process.env.GATEWAY_MANAGER_DB.replace(/\/[^/]+$/, '')
  : config.dataDir
const dbPath = process.env.GATEWAY_MANAGER_DB ?? join(dataDir, 'manager.db')

const runtimeKind = process.env.GW_EXT_RUNTIME ?? 'docker'
const runtime = runtimeKind === 'local'
  ? new LocalProcessRuntime()
  : new DockerRuntime({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' })

const manager = new ExtensionManager({
  store: new ManagerStore(dbPath),
  runtime,
  network: process.env.GW_EXT_NETWORK ?? 'gw-ext-net',
  // operator-supplied env for manifest-allowlisted keys (e.g. the CodeBuddy
  // extension's CODEBUDDY_PRODUCT=buddy-intl for the intl install). JSON map
  // via GW_OPERATOR_ENV; empty by default.
  operatorEnv: process.env.GW_OPERATOR_ENV ? JSON.parse(process.env.GW_OPERATOR_ENV) as Record<string, string> : {},
  registrationSecret: process.env.GATEWAY_SECRET,
})

const server = await startManagerApi({
  manager,
  token,
  host: process.env.GW_MANAGER_ALLOW_REMOTE ? '0.0.0.0' : '127.0.0.1',
  port: Number(process.env.HTTP_PORT ?? 9100),
})

const addr = server.address()
const port = typeof addr === 'object' && addr ? addr.port : Number(process.env.HTTP_PORT ?? 9100)
console.log(`[manager] listening on :${port} (runtime=${runtimeKind}, db=${dbPath})`)

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[manager] ${sig}, closing`)
    server.close()
    process.exit(0)
  })
}
