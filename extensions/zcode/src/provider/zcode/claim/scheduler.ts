/**
 * Auto-claim scheduler — polls the manual-claim enumeration and claims a
 * trial/weekend plan the moment it becomes available (first-come-first-served:
 * the server caps daily claims, biz 1005).
 *
 * Ported from TriDefender/zcode-api (`src/claim/scheduler.ts`, CC BY-NC-SA 4.0
 * — see THIRD-PARTY-NOTICES.md). Backoff semantics per failure kind:
 *   - success / already_claimed → hold until the plan's `ends_at`
 *   - quota_exhausted           → hold until `failureEndsAt` else cooldown
 *   - ineligible / unavailable / not_found → cooldown
 *   - captcha / network / unknown          → cooldown
 *   - login_required                      → stop (needs re-login)
 *
 * `startsAt` / `endsAt` / `failureEndsAt` are unix SECONDS (the desktop client
 * compares them against `Date.now() / 1e3`).
 */
import type { ClaimOutcome, ClaimablePlan } from './types.js'
import { ClaimPreviewError } from './types.js'

export interface ClaimGateway {
  /** Merged enumeration: billing preview + marketing banner plans. */
  listPlans(): Promise<ClaimablePlan[]>
  /** `captcha` omitted → claim without captcha headers. */
  claim(planId: string, captcha?: { verifyParam: string; region?: string }): Promise<ClaimOutcome>
}

export interface ClaimSchedulerConfig {
  /** Claim only this plan_id; empty = highest-priority plan. */
  planId?: string
  pollIntervalMs: number
  cooldownMs: number
}

export interface ClaimSchedulerDeps {
  getJwt(): Promise<string | undefined>
  createClient(jwt: string): ClaimGateway
  getCaptcha(): Promise<{ verifyParam: string; region?: string }>
  captchaRequired?: () => Promise<boolean> | boolean
  config: ClaimSchedulerConfig
  log?: (message: string) => void
  now?: () => number
}

export type TickResult =
  | { action: 'skipped_hold' }
  | { action: 'stopped' }
  | { action: 'idle' }
  | { action: 'claimed'; planId: string; startsAt?: number; endsAt?: number }
  | { action: 'failed'; outcome: Extract<ClaimOutcome, { ok: false }>; holdMs: number }
  | { action: 'error'; message: string; holdMs: number }

export class ClaimScheduler {
  private stopped = false
  private holdUntil = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(private readonly deps: ClaimSchedulerDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
  }

  isStopped(): boolean {
    return this.stopped
  }

  start(): void {
    if (this.stopped) return
    this.scheduleNext(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** One poll→claim cycle. Exposed for tests; `start()` drives it on a timer. */
  async tick(): Promise<TickResult> {
    if (this.stopped) return { action: 'stopped' }
    const nowMs = this.now()
    if (nowMs < this.holdUntil) return { action: 'skipped_hold' }

    let jwt: string | undefined
    try {
      jwt = await this.deps.getJwt()
    } catch (err) {
      return this.errorBackoff(`credential resolution failed: ${(err as Error).message}`)
    }
    if (!jwt) {
      // Missing JWT is "login pending", not fatal: back off and retry.
      return this.errorBackoff('no JWT available (oauth login pending)')
    }

    const client = this.deps.createClient(jwt)
    let plans: ClaimablePlan[]
    try {
      plans = await client.listPlans()
    } catch (err) {
      // 404 = campaign endpoint not deployed yet (expected pre-launch state).
      if (err instanceof ClaimPreviewError && err.status === 404) {
        this.holdUntil = nowMs + this.deps.config.pollIntervalMs
        return { action: 'idle' }
      }
      return this.errorBackoff(`preview failed: ${(err as Error).message}`)
    }
    if (plans.length === 0) {
      this.holdUntil = nowMs + this.deps.config.pollIntervalMs
      return { action: 'idle' }
    }

    const target = this.pickPlan(plans)
    if (!target) {
      // Configured planId not in the current list — plain poll cadence.
      this.holdUntil = nowMs + this.deps.config.pollIntervalMs
      return { action: 'idle' }
    }

    let captchaRequired = true
    if (this.deps.captchaRequired) {
      try {
        captchaRequired = await this.deps.captchaRequired()
      } catch {
        captchaRequired = true
      }
    }

    let captcha: { verifyParam: string; region?: string } | undefined
    if (captchaRequired) {
      try {
        captcha = await this.deps.getCaptcha()
      } catch (err) {
        return this.errorBackoff(`captcha token failed: ${(err as Error).message}`)
      }
    }

    let outcome: ClaimOutcome
    try {
      outcome = await client.claim(target.planId, captcha)
    } catch (err) {
      return this.errorBackoff(`claim request failed: ${(err as Error).message}`)
    }

    if (outcome.ok) {
      const endsAtMs = outcome.endsAt !== undefined ? outcome.endsAt * 1000 : undefined
      this.holdUntil = endsAtMs ?? nowMs + this.deps.config.pollIntervalMs
      this.log(`claim: claimed plan ${target.planId}${outcome.startsAt !== undefined ? ` (activates ${new Date(outcome.startsAt * 1000).toISOString()})` : ''}`)
      return { action: 'claimed', planId: target.planId, startsAt: outcome.startsAt, endsAt: outcome.endsAt }
    }

    const holdMs = this.holdForFailure(outcome.failureKind, outcome.failureEndsAt, nowMs)
    this.holdUntil = nowMs + holdMs
    this.log(`claim: ${outcome.failureKind} (${outcome.code}) — ${outcome.message}; retry in ${Math.round(holdMs / 1000)}s`)
    if (outcome.failureKind === 'login_required') this.stop()
    return { action: 'failed', outcome, holdMs }
  }

  private pickPlan(plans: ClaimablePlan[]): ClaimablePlan | null {
    const wanted = this.deps.config.planId?.trim()
    if (wanted) return plans.find((plan) => plan.planId === wanted) ?? null
    // Server order first, highest priority breaks ties (stable sort).
    const sorted = [...plans].sort((a, b) => b.priority - a.priority)
    return sorted[0] ?? null
  }

  private holdForFailure(
    kind: Extract<ClaimOutcome, { ok: false }>['failureKind'],
    failureEndsAtSec: number | undefined,
    nowMs: number,
  ): number {
    if ((kind === 'already_claimed' || kind === 'quota_exhausted') && Number.isFinite(failureEndsAtSec)) {
      const untilMs = (failureEndsAtSec as number) * 1000
      if (untilMs > nowMs) return Math.min(untilMs - nowMs, 24 * 60 * 60 * 1000)
    }
    return this.deps.config.cooldownMs
  }

  private errorBackoff(message: string): TickResult {
    const holdMs = this.deps.config.cooldownMs
    this.holdUntil = this.now() + holdMs
    this.log(`claim: ${message}; retry in ${Math.round(holdMs / 1000)}s`)
    return { action: 'error', message, holdMs }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick().finally(() => this.scheduleNext(this.nextDelay()))
    }, delayMs)
    this.timer.unref?.()
  }

  private nextDelay(): number {
    const remaining = this.holdUntil - this.now()
    return remaining > 0 ? remaining : this.deps.config.pollIntervalMs
  }
}
