/**
 * gateway-extension-zcode — entrypoint.
 *
 * Boots the ZCode provider, ties it to the Extension Protocol HTTP server,
 * wires a health probe, and starts listening. Runs as a standalone process or
 * container; it has no knowledge of any Gateway Core.
 */
import { loadConfig } from './util/config.js'
import { Logger } from './util/logger.js'
import { Store } from './storage/store.js'
import { ZCodeProvider } from './provider/zcode/index.js'
import { createExtensionServer } from './server/router.js'
import { ActiveRequestRegistry } from './server/registry.js'

export interface App {
  server: import('node:http').Server
  provider: ZCodeProvider
  store: Store
  registry: ActiveRequestRegistry
  close: () => Promise<void>
}

export async function startApp(
  config = loadConfig(),
  overrides: { fetcher?: typeof fetch; store?: Store } = {},
): Promise<App> {
  const logger = new Logger(config.logLevel)
  const store = overrides.store
    ?? new Store(config.dataDir, process.env.EXTENSION_ENCRYPTION_KEY)
  const registry = new ActiveRequestRegistry()
  const provider = new ZCodeProvider({
    config,
    store,
    logger,
    fetcher: overrides.fetcher,
  })

  const server = createExtensionServer({
    config,
    logger,
    provider,
    registry,
    health: () => ({ status: 'healthy' }),
  })

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve)
  })
  logger.info('extension.started', {
    id: 'zcode',
    version: '1.0.0',
    port: config.port,
    host: config.host,
    data_dir: config.dataDir,
  })

  const handleSignal = (): void => {
    registry.abortAll()
    server.close(() => {
      store.close()
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.once('SIGINT', handleSignal)
  process.once('SIGTERM', handleSignal)

  return {
    server: server,
    provider: provider,
    store: store,
    registry: registry,
    close: async () => {
      registry.abortAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await provider.shutdownCaptcha()
      store.close()
    },
  }
}

function isEntryPoint(): boolean {
  const arg = process.argv[1]
  if (!arg) return false
  try {
    const resolved = new URL(arg, `file://${process.cwd()}/`).href
    const self = new URL(import.meta.url).href
    return self === resolved || self === `file://${arg}`
  } catch {
    return false
  }
}
if (isEntryPoint()) {
  startApp().catch((error) => {
    console.error('failed to start extension:', error)
    process.exit(1)
  })
}
