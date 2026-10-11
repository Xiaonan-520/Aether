/**
 * Extension Manager — public surface.
 *
 * Phase 2 delivers: lifecycle (install/stop/restart/remove/list), the
 * manifest → sanitized-runtime conversion boundary, the manager store, an
 * authenticated loopback HTTP API, and two container runtimes (Docker for
 * deployment, local-process for dev/tests).
 */

export * from './runtime.js'
export * from './policy.js'
export * from './store.js'
export * from './extension-manager.js'
export * from './api.js'
export * from './docker-api.js'
export * from './local-runtime.js'
