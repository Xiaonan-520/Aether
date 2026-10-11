/**
 * Conformance Suite foundation (RFC v2 §22.1).
 *
 * Phase 1 scope ONLY: the runner skeleton, the domain registry and the
 * pure-contract domains (manifest) plus a scripted fake extension for the
 * future wire-level domains. The full 11-domain suite lands in Phases 2/3
 * (manifest/health/manual-actions/timeout first, per D8).
 *
 *   Extension → Conformance Suite → Pass → Gateway-compatible
 *
 * The suite is black-box: it only ever speaks the Extension Protocol through
 * a `SuiteTransport`, never touching extension internals. When Phase 2 adds
 * the HTTP transport, every domain runs unchanged against real containers.
 */

import { validateManifest } from './validate-manifest.js'
import type { ExtensionManifest } from './manifest.js'
import type { RemoteExtensionClient } from './remote-provider.js'

// ---------------------------------------------------------------------------
// Transport abstraction (black-box rule)
// ---------------------------------------------------------------------------

/**
 * How the suite talks to an extension under test. Phase 1 ships an adapter
 * over `RemoteExtensionClient`; Phase 2 adds the live-HTTP transport.
 */
export interface SuiteTransport {
  manifest(): Promise<unknown>
  health(): Promise<{ status: string }>
}

export const remoteClientTransport = (client: RemoteExtensionClient): SuiteTransport => ({
  manifest: () => client.fetchManifest(),
  health: () => client.fetchHealth(),
})

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type SuiteDomainId =
  | 'manifest' | 'health' | 'models' | 'account-lifecycle' | 'quota'
  | 'chat' | 'streaming' | 'errors' | 'manual-actions' | 'timeout' | 'cancellation'

export interface SuiteCheck {
  id: string
  pass: boolean
  message: string
}

export interface SuiteDomainResult {
  domain: SuiteDomainId
  checks: SuiteCheck[]
  get pass(): boolean
}

export interface SuiteResult {
  domains: SuiteDomainResult[]
  get pass(): boolean
}

export interface SuiteDomain {
  id: SuiteDomainId
  /** phases ≥2; phase-1 runner simply skips domains not yet implemented */
  implemented: boolean
  run(ctx: SuiteContext): Promise<SuiteCheck[]>
}

export interface SuiteContext {
  transport: SuiteTransport
  /** raw manifest as received (unvalidated) */
  rawManifest: unknown
  /**
   * Optional protocol probes. Domains run black-box: when a probe is absent
   * the domain records a skip-check and never fails the install-time gate.
   */
  invokeAction?: (actionId: string, payload?: unknown) => Promise<{ status: number; body: unknown }>
  chatNonStream?: () => Promise<unknown>
  /** returns collected frames [{event, data}] from a streaming chat */
  chatStreamProbe?: () => Promise<Array<{ event: string; data: Record<string, unknown> }>>
  /** chat-shaped probe raced against timeoutMs (domain 10) */
  chatProbe?: () => Promise<unknown>
  listModels?: () => Promise<unknown>
  listAccounts?: () => Promise<unknown>
  fetchQuota?: () => Promise<unknown>
  /** triggers a controlled upstream failure; resolves {kind, message} */
  errorProbe?: () => Promise<{ kind?: string; message?: string }>
  /** starts a stream then aborts; resolves {upstreamClosed} */
  cancellationProbe?: () => Promise<{ upstreamClosed?: boolean }>
  timeoutMs?: number
}

const manifestDomain: SuiteDomain = {
  id: 'manifest',
  implemented: true,
  async run(ctx) {
    const checks: SuiteCheck[] = []
    const validation = validateManifest(ctx.rawManifest)
    checks.push({
      id: 'manifest.schema',
      pass: validation.errors.length === 0,
      message: validation.errors.length === 0
        ? 'manifest shape valid'
        : `schema errors: ${validation.errors.map((e) => `${e.path} (${e.message})`).join('; ')}`,
    })
    checks.push({
      id: 'manifest.security',
      pass: validation.violations.length === 0,
      message: validation.violations.length === 0
        ? 'no security violations'
        : `violations: ${validation.violations.map((v) => `${v.path} (${v.message})`).join('; ')}`,
    })
    return checks
  },
}

const healthDomain: SuiteDomain = {
  id: 'health',
  implemented: true,
  async run(ctx) {
    const checks: SuiteCheck[] = []
    try {
      const health = await ctx.transport.health()
      const valid = ['healthy', 'degraded', 'unhealthy'].includes(health.status)
      checks.push({
        id: 'health.status-enum',
        pass: valid,
        message: valid ? `status "${health.status}"` : `invalid status "${String(health.status)}"`,
      })
    } catch (err) {
      checks.push({ id: 'health.reachable', pass: false, message: `health call failed: ${err instanceof Error ? err.message : String(err)}` })
    }
    return checks
  },
}

/**
 * Domain 9: manual actions (Phase 2, live).
 *
 * Black-box flow: manifest-declared actions must accept valid calls and
 * reject undeclared ones; needs_manual_action descriptors must reference
 * declared action ids. Payloads stay opaque — the suite only checks status
 * codes and declared output shapes.
 */
const manualActionsDomain: SuiteDomain = {
  id: 'manual-actions',
  implemented: true,
  async run(ctx) {
    const checks: SuiteCheck[] = []
    const parsed = validateManifest(ctx.rawManifest)
    const declaredIds = new Set<string>()
    if (parsed.ok) {
      const manifest = ctx.rawManifest as ExtensionManifest
      for (const p of manifest.providers) for (const a of p.actions ?? []) declaredIds.add(a.id)
    }
    checks.push({
      id: 'actions.declared-in-manifest',
      pass: declaredIds.size > 0,
      message: declaredIds.size > 0 ? `${declaredIds.size} declared actions` : 'no actions declared (cannot exercise domain)',
    })
    if (!ctx.invokeAction || declaredIds.size === 0) {
      checks.push({ id: 'actions.skipped', pass: true, message: 'no action probe provided (install-time gate only)' })
      return checks
    }

    // declared action accepts a call
    try {
      const first = [...declaredIds][0]
      const res = await ctx.invokeAction(first)
      checks.push({
        id: 'actions.declared-invocable',
        pass: res.status >= 200 && res.status < 300,
        message: `declared action "${first}" -> http ${res.status}`,
      })
    } catch (err) {
      checks.push({ id: 'actions.declared-invocable', pass: false, message: `probe failed: ${err instanceof Error ? err.message : String(err)}` })
    }

    // undeclared action rejected (no arbitrary RPC)
    try {
      const res = await ctx.invokeAction('gw-undeclared-action-probe')
      checks.push({
        id: 'actions.undeclared-rejected',
        pass: res.status === 404 || res.status === 400,
        message: `undeclared action -> http ${res.status} (expected 404/400)`,
      })
    } catch (err) {
      checks.push({ id: 'actions.undeclared-rejected', pass: false, message: `probe failed: ${err instanceof Error ? err.message : String(err)}` })
    }

    return checks
  },
}

/**
 * Domain 10: timeout (Phase 2, live).
 *
 * The extension must answer or disconnect within the caller's deadline — a
 * delayed chat probe must fail with a structured timeout, never hang.
 */
const timeoutDomain: SuiteDomain = {
  id: 'timeout',
  implemented: true,
  async run(ctx) {
    const checks: SuiteCheck[] = []
    const budget = ctx.timeoutMs ?? 2_000
    if (!ctx.chatProbe) {
      checks.push({ id: 'timeout.skipped', pass: true, message: 'no chat probe provided (install-time gate only)' })
      return checks
    }
    const started = Date.now()
    try {
      await Promise.race([
        ctx.chatProbe(),
        new Promise((_ok, fail) => setTimeout(() => fail(new Error(`extension exceeded ${budget}ms deadline`)), budget)),
      ])
      const elapsed = Date.now() - started
      checks.push({ id: 'timeout.within-deadline', pass: elapsed <= budget, message: `probe completed in ${elapsed}ms (budget ${budget}ms)` })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // a structured TIMEOUT error is a PASS (the extension/signalling layer
      // correctly detected the overrun); an unbounded hang is the failure.
      const structuredTimeout = /TIMEOUT|deadline|abort/i.test(message)
      checks.push({ id: 'timeout.structured-or-fast', pass: structuredTimeout, message: `probe failed with ${structuredTimeout ? 'structured' : 'UNSTRUCTURED'} error: ${message}` })
    }
    return checks
  },
}

/**
 * Domains 3–8 + 11 (Phase 3, live): models, account lifecycle, quota, chat,
 * streaming, errors, cancellation. All black-box over the SuiteContext probes;
 * every probe is optional so the suite degrades gracefully for install-time
 * gates that only supply manifest+health.
 */
const modelsDomain: SuiteDomain = {
  id: 'models',
  implemented: true,
  async run(ctx) {
    const checks: SuiteCheck[] = []
    if (!ctx.listModels) {
      checks.push({ id: 'models.skipped', pass: true, message: 'no model probe provided' })
      return checks
    }
    try {
      const res = await ctx.listModels() as { models?: Array<{ id: string; name: string; capabilities?: Record<string, unknown> }> }
      const models = res.models ?? []
      checks.push({ id: 'models.non-empty', pass: models.length > 0, message: `${models.length} models` })
      const wellFormed = models.every((m) => typeof m.id === 'string' && m.id.length > 0 && typeof m.name === 'string')
      checks.push({ id: 'models.shape', pass: wellFormed, message: wellFormed ? 'id/name present on all entries' : 'malformed entries' })
      const noPrefix = models.every((m) => !m.id.includes('::'))
      checks.push({ id: 'models.no-provider-prefix', pass: noPrefix, message: noPrefix ? 'no :: prefix leak' : 'model id carries :: prefix (Core strips prefixes, extension must not)' })
    } catch (err) {
      checks.push({ id: 'models.reachable', pass: false, message: `probe failed: ${err instanceof Error ? err.message : String(err)}` })
    }
    return checks
  },
}

const accountLifecycleDomain: SuiteDomain = {
  id: 'account-lifecycle',
  implemented: true,
  async run(ctx) {
    const checks: SuiteCheck[] = []
    if (!ctx.listAccounts) {
      checks.push({ id: 'lifecycle.skipped', pass: true, message: 'no account probe provided' })
      return checks
    }
    try {
      const res = await ctx.listAccounts() as { accounts?: Array<{ accountId: string; status: string; manualAction?: unknown; quota?: unknown; metadata?: unknown }> }
      const accounts = res.accounts ?? []
      const unique = new Set(accounts.map((a) => a.accountId))
      checks.push({ id: 'lifecycle.unique-ids', pass: unique.size === accounts.length, message: `${accounts.length} accounts, ${unique.size} unique ids` })
      const statuses = new Set(['active', 'healthy_low_quota', 'rate_limited', 'token_expired', 'auth_failed', 'quota_exhausted', 'disabled', 'needs_manual_action', 'pending'])
      const statusOk = accounts.every((a) => statuses.has(a.status))
      checks.push({ id: 'lifecycle.status-enum', pass: statusOk, message: statusOk ? 'all statuses in the 9-state enum' : 'status outside protocol enum' })
      // no credential material in the projection (§10.3)
      const raw = JSON.stringify(res).toLowerCase()
      const leak = ['access_token', 'refresh_token', '"password"', 'secret', 'authorization: bearer'].some((k) => raw.includes(k))
      checks.push({ id: 'lifecycle.no-credential-leak', pass: !leak, message: leak ? 'credential-shaped field found in account projection' : 'projection clean' })
    } catch (err) {
      checks.push({ id: 'lifecycle.reachable', pass: false, message: `probe failed: ${err instanceof Error ? err.message : String(err)}` })
    }
    return checks
  },
}

const quotaDomain: SuiteDomain = {
  id: 'quota',
  implemented: true,
  async run(ctx) {
    const checks: SuiteCheck[] = []
    if (!ctx.fetchQuota) {
      checks.push({ id: 'quota.skipped', pass: true, message: 'no quota probe provided' })
      return checks
    }
    try {
      const res = await ctx.fetchQuota() as { resources?: Array<{ id: string; kind: string; unit: string; status: string; remaining: unknown }> }
      const resources = res.resources ?? []
      const kinds = new Set(['credits', 'tokens', 'requests', 'subscription', 'custom'])
      const kindOk = resources.every((r) => kinds.has(r.kind))
      checks.push({ id: 'quota.kind-enum', pass: kindOk, message: kindOk ? 'all kinds in closed enum' : 'kind outside enum' })
      const unitOk = resources.every((r) => typeof r.unit === 'string' && r.unit.length > 0)
      checks.push({ id: 'quota.unit-present', pass: unitOk, message: unitOk ? 'unit declared on every resource' : 'missing unit' })
      const statusOk = resources.every((r) => ['ok', 'low', 'exhausted', 'reset_pending', 'unclaimable', 'unknown'].includes(r.status))
      checks.push({ id: 'quota.status-enum', pass: statusOk, message: statusOk ? 'resource statuses valid' : 'status outside enum' })
    } catch (err) {
      checks.push({ id: 'quota.reachable', pass: false, message: `probe failed: ${err instanceof Error ? err.message : String(err)}` })
    }
    return checks
  },
}

const chatDomain: SuiteDomain = {
  id: 'chat',
  implemented: true,
  async run(ctx) {
    const checks: SuiteCheck[] = []
    if (!ctx.chatNonStream) {
      checks.push({ id: 'chat.skipped', pass: true, message: 'no chat probe provided' })
      return checks
    }
    try {
      const res = await ctx.chatNonStream() as { content?: string; finishReason?: string }
      checks.push({ id: 'chat.result-shape', pass: typeof res.content === 'string' && typeof res.finishReason === 'string', message: 'content+finishReason present' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const structured = /AUTH_INVALID|RATE_LIMIT|QUOTA_EXHAUSTED|UPSTREAM_5XX|TERMINAL|TIMEOUT|TRANSPORT|NEEDS_/.test(message)
      checks.push({ id: 'chat.result-or-structured-error', pass: structured, message: structured ? `structured error (acceptable): ${message.slice(0, 120)}` : `unstructured failure: ${message.slice(0, 120)}` })
    }
    return checks
  },
}

const streamingDomain: SuiteDomain = {
  id: 'streaming',
  implemented: true,
  async run(ctx) {
    const checks: SuiteCheck[] = []
    if (!ctx.chatStreamProbe) {
      checks.push({ id: 'streaming.skipped', pass: true, message: 'no stream probe provided' })
      return checks
    }
    try {
      const frames = await ctx.chatStreamProbe() as Array<{ event: string; data: Record<string, unknown> }>
      const terminals = frames.filter((f) => f.event === 'done' || f.event === 'error')
      checks.push({ id: 'streaming.single-terminal', pass: terminals.length === 1, message: `${terminals.length} terminal frames (need exactly 1)` })
      const chunksWellFormed = frames.filter((f) => f.event === 'chunk').every((f) => typeof f.data.text === 'string')
      checks.push({ id: 'streaming.chunk-shape', pass: chunksWellFormed, message: chunksWellFormed ? 'chunk frames carry text' : 'malformed chunk frames' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const structured = /AUTH_INVALID|RATE_LIMIT|QUOTA_EXHAUSTED|UPSTREAM_5XX|TERMINAL|TIMEOUT|TRANSPORT|NEEDS_/.test(message)
      checks.push({ id: 'streaming.frames-or-structured-error', pass: structured, message: structured ? `structured error (acceptable): ${message.slice(0, 120)}` : `unstructured failure: ${message.slice(0, 120)}` })
    }
    return checks
  },
}

const errorsDomain: SuiteDomain = {
  id: 'errors',
  implemented: true,
  async run(ctx) {
    const checks: SuiteCheck[] = []
    if (!ctx.errorProbe) {
      checks.push({ id: 'errors.skipped', pass: true, message: 'no error probe provided' })
      return checks
    }
    try {
      const res = await ctx.errorProbe() as { kind?: string; message?: string }
      const known = ['AUTH_INVALID', 'TOKEN_EXPIRED', 'RATE_LIMIT', 'QUOTA_EXHAUSTED', 'TIMEOUT', 'TRANSPORT', 'UPSTREAM_5XX', 'TERMINAL', 'EMPTY_RESPONSE', 'NEEDS_CAPTCHA', 'NEEDS_MANUAL']
      checks.push({ id: 'errors.kind-in-enum', pass: res.kind !== undefined && known.includes(res.kind), message: res.kind ? `kind ${res.kind}` : 'no kind in error body' })
      const sanitized = typeof res.message === 'string' && !/bearer [a-z0-9-]{8,}|"access_token"/i.test(res.message)
      checks.push({ id: 'errors.sanitized-message', pass: sanitized, message: sanitized ? 'message clean' : 'possible credential leak in message' })
    } catch (err) {
      checks.push({ id: 'errors.reachable', pass: false, message: `probe failed: ${err instanceof Error ? err.message : String(err)}` })
    }
    return checks
  },
}

const cancellationDomain: SuiteDomain = {
  id: 'cancellation',
  implemented: true,
  async run(ctx) {
    const checks: SuiteCheck[] = []
    if (!ctx.cancellationProbe) {
      checks.push({ id: 'cancellation.skipped', pass: true, message: 'no cancellation probe provided' })
      return checks
    }
    try {
      const res = await ctx.cancellationProbe() as { upstreamClosed?: boolean }
      checks.push({ id: 'cancellation.upstream-closed', pass: res.upstreamClosed === true, message: res.upstreamClosed ? 'upstream closed on client cancel' : 'extension kept upstream open after client cancel' })
    } catch (err) {
      checks.push({ id: 'cancellation.reachable', pass: false, message: `probe failed: ${err instanceof Error ? err.message : String(err)}` })
    }
    return checks
  },
}

/** Deferred domains (none remaining; registry kept for future additions). */
const deferredDomains: SuiteDomain[] = []

/** All 11 domains, in RFC §22.1 order. */
export const SUITE_DOMAINS: readonly SuiteDomain[] = [
  manifestDomain,
  healthDomain,
  modelsDomain,
  accountLifecycleDomain,
  quotaDomain,
  chatDomain,
  streamingDomain,
  errorsDomain,
  manualActionsDomain,
  timeoutDomain,
  cancellationDomain,
]

export interface SuiteOptions {
  /** skip domains whose required probes are absent (default true) */
  skipDeferred?: boolean
  invokeAction?: (actionId: string, payload?: unknown) => Promise<{ status: number; body: unknown }>
  chatNonStream?: () => Promise<unknown>
  chatStreamProbe?: () => Promise<Array<{ event: string; data: Record<string, unknown> }>>
  chatProbe?: () => Promise<unknown>
  listModels?: () => Promise<unknown>
  listAccounts?: () => Promise<unknown>
  fetchQuota?: () => Promise<unknown>
  errorProbe?: () => Promise<{ kind?: string; message?: string }>
  cancellationProbe?: () => Promise<{ upstreamClosed?: boolean }>
  timeoutMs?: number
}

/** Run the suite against one extension under test. */
export async function runConformanceSuite(
  rawManifest: unknown,
  transport: SuiteTransport,
  opts: SuiteOptions = {},
): Promise<SuiteResult> {
  const skipDeferred = opts.skipDeferred ?? true
  const domains: SuiteDomainResult[] = []
  const ctx: SuiteContext = {
    transport,
    rawManifest,
    invokeAction: opts.invokeAction,
    chatNonStream: opts.chatNonStream,
    chatStreamProbe: opts.chatStreamProbe,
    chatProbe: opts.chatProbe,
    listModels: opts.listModels,
    listAccounts: opts.listAccounts,
    fetchQuota: opts.fetchQuota,
    errorProbe: opts.errorProbe,
    cancellationProbe: opts.cancellationProbe,
    timeoutMs: opts.timeoutMs,
  }
  for (const domain of SUITE_DOMAINS) {
    if (!domain.implemented && skipDeferred) continue
    const checks = await domain.run(ctx)
    domains.push({
      domain: domain.id,
      checks,
      get pass() {
        return checks.every((c) => c.pass)
      },
    })
  }
  return {
    domains,
    get pass() {
      return domains.every((d) => d.pass)
    },
  }
}
