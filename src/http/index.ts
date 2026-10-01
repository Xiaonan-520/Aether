/**
 * Gateway bootstrap: config → store (SQLite with MemoryStore fallback) →
 * cipher → registry → services → scheduler → HTTP server. Graceful shutdown
 * on SIGTERM/SIGINT (Docker stop).
 */
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../config/index.js'
import { CredentialCipher } from '../store/crypto.js'
import { MemoryStore } from '../store/memory-store.js'
import { openSqliteStore } from '../store/sqlite/sqlite-store.js'
import type { StoreGateway } from '../store/types.js'
import { ProviderRegistry } from '../core/registry/provider-registry.js'
import { ModelRouter } from '../core/router/model-router.js'
import { AccountPool } from '../core/pool/account-pool.js'
import { Scheduler } from '../core/worker/scheduler.js'
import { createGatewayApp } from './app.js'
import { registerProviders } from '../providers/register.js'
import { resolveCredentialJson } from '../service/context.js'
import type { ServiceContext } from '../service/context.js'
import type { ProviderCtx } from '../core/registry/provider.js'
import type { Account } from '../core/types.js'
import type { Job } from '../store/types.js'

async function openStore(dataDir: string): Promise<{ store: StoreGateway; backend: 'sqlite' | 'memory' }> {
  mkdirSync(dataDir, { recursive: true })
  const sqlite = await openSqliteStore(join(dataDir, 'gateway.db'))
  if (sqlite) return { store: sqlite, backend: 'sqlite' }
  console.warn('better-sqlite3 unavailable; falling back to in-memory store (data will NOT persist)')
  return { store: new MemoryStore(), backend: 'memory' }
}

export async function main(): Promise<void> {
  const config = loadConfig()
  const { store, backend } = await openStore(config.dataDir)
  const cipher = new CredentialCipher(config.gatewaySecret)
  const registry = new ProviderRegistry()
  // Phase 3B: WorkBuddy + CodeBuddy (shared Buddy protocol) and ZCode.
  const { captcha } = registerProviders(registry)
  // Persist the registered providers: accounts.provider has a foreign key to
  // the providers table (with foreign_keys = ON), so an account cannot be
  // created until its provider row exists.
  store.upsertProviders(registry.list().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    capabilitiesJson: JSON.stringify(p.capabilities),
  })))

  /** Build a ProviderCtx that resolves the *decrypted* credential. */
  const providerCtx = (provider: string): ProviderCtx => ({
    provider,
    resolveCredential: async (a: Account) => {
      const credential = resolveCredentialJson<unknown>({ ...ctx, now: () => Date.now() } as ServiceContext, a)
      if (!credential) return undefined
      return { ref: a.credentialKey, expiresAt: a.tokenExpiryAt, refreshable: a.refreshable, credential }
    },
  })

  const pool = new AccountPool({
    listAccounts: (provider) => store.listAccounts(provider).map((s) => s.account),
    patchAccount: (id, patch) => void store.patchAccount(id, patch),
    hasCredential: (account) => store.getAccount(account.id)?.credential != null,
    refreshAccount: async (account) => {
      const adapter = registry.get(account.provider)
      if (!adapter?.ops.refreshAccount) {
        throw new Error(`provider "${account.provider}" does not support refresh`)
      }
      const result = await adapter.ops.refreshAccount(providerCtx(account.provider), account)
      if (result.refreshed) {
        store.patchAccount(account.id, { tokenExpiryAt: result.expiresAt, status: 'active' })
        return { ...account, tokenExpiryAt: result.expiresAt, status: 'active' }
      }
      return account
    },
  })

  const ctx: ServiceContext = {
    config,
    store,
    cipher,
    registry,
    router: new ModelRouter(registry, () => store.listModels()),
    pool,
    captcha,
    now: () => Date.now(),
  }

  const scheduler = new Scheduler({ store, registry })
  // Scheduler executors (idempotent per account; the framework handles retry,
  // backoff, cooldown and concurrency). credit_claim is intentionally absent:
  // neither WorkBuddy nor ZCode exposes a claim the gateway may call.
  const execFor = (provider: string) => registry.get(provider)
  scheduler.setExecutor('token_refresh', async (job: Job, account: Account) => {
    const adapter = execFor(account.provider)
    if (!adapter?.ops.refreshAccount) return { skipped: 'unsupported' }
    const result = await adapter.ops.refreshAccount(providerCtx(account.provider), account)
    if (result.refreshed) store.patchAccount(account.id, { tokenExpiryAt: result.expiresAt, status: 'active' })
    return result
  })
  scheduler.setExecutor('quota_sync', async (_job: Job, account: Account) => {
    const adapter = execFor(account.provider)
    if (!adapter?.ops.getQuota) return { skipped: 'unsupported' }
    const quota = await adapter.ops.getQuota(providerCtx(account.provider), account)
    store.patchAccount(account.id, { quotaJson: quota.rawJson, lastQuotaAt: quota.lastUpdatedAt })
    return { known: quota.known, remaining: quota.remaining }
  })
  scheduler.setExecutor('health_check', async (_job: Job, account: Account) => {
    const adapter = execFor(account.provider)
    if (!adapter?.ops.healthCheck) return { skipped: 'unsupported' }
    return adapter.ops.healthCheck(providerCtx(account.provider), account)
  })
  scheduler.start()

  const { app, listen } = createGatewayApp(ctx)
  const server = (await listen(config.httpPort, config.httpHost)) as { close: (cb: () => void) => void }
  console.log(`store backend: ${backend}; data dir: ${config.dataDir}`)

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`received ${signal}; draining...`)
    await scheduler.stop()
    store.addEvent({ ts: Date.now(), level: 'info', kind: 'gateway.shutdown', message: signal })
    if (backend === 'sqlite') {
      ;(store as unknown as { close?: () => void }).close?.()
    }
    server.close(() => process.exit(0))
    // hard exit if close hangs
    setTimeout(() => process.exit(0), 5_000).unref()
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // keep the app referenced (hono node-server holds it via serve)
  void app
}

// entrypoint when run directly
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  main().catch((err) => {
    console.error('gateway failed to start:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
