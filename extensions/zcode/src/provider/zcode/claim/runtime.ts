/**
 * Auto-claim runtime — wires the scheduler to this extension's stores.
 *
 * Ported from TriDefender/zcode-api (`src/claim/runtime.ts`, CC BY-NC-SA 4.0 —
 * see THIRD-PARTY-NOTICES.md), adapted to the multi-account extension model:
 * the reference proxy has a single credential, while this extension holds a
 * pool. Each account runs its own scheduler, so a trial campaign can be claimed
 * per account and one account's `login_required` does not stop the others.
 *
 * Claims are enabled by default (`ZCODE_AUTO_CLAIM=0` disables them), matching
 * the reference's `claim.enabled`/`claim.auto` defaults.
 */
import type { Logger } from '../../../util/logger.js'
import type { AppConfig } from '../../../util/config.js'
import type { Store, ZCodeCredentialRecord, AccountRow } from '../../../storage/store.js'
import { createClaimClient } from './client.js'
import { ClaimScheduler } from './scheduler.js'
import type { ClaimOutcome } from './types.js'

export interface ClaimRuntimeOptions {
  config: AppConfig
  store: Store
  logger: Logger
  /** Latest known captcha token; throws when none can be produced. */
  getCaptchaToken: () => Promise<{ verifyParam: string; region?: string }>
  /** Whether the claim plane still gates on captcha (configs mirror). */
  captchaRequired?: () => Promise<boolean> | boolean
  fetcher?: typeof fetch
  now?: () => number
}

export interface ClaimState {
  accountId: string
  running: boolean
  lastOutcome?: ClaimOutcome
  holdUntil?: number
}

/**
 * One scheduler per account, keyed by account id. Ticks are serialised per
 * account by the scheduler itself; `start()` is idempotent.
 */
export class AutoClaimRuntime {
  private readonly schedulers = new Map<string, ClaimScheduler>()
  private readonly states = new Map<string, ClaimState>()

  constructor(private readonly opts: ClaimRuntimeOptions) {}

  get enabled(): boolean {
    return this.opts.config.autoClaim
  }

  /** Start (or restart) claiming for every account that has a usable credential. */
  startAll(): void {
    if (!this.enabled) {
      this.opts.logger.info('claim.disabled', { reason: 'ZCODE_AUTO_CLAIM=0' })
      return
    }
    for (const row of this.opts.store.listAccounts()) {
      if (!row.enabled) continue
      const credential = this.opts.store.getCredential(row.id)
      if (!credential?.jwt_token) continue
      this.startAccount(row)
    }
  }

  startAccount(row: AccountRow): void {
    if (!this.enabled) return
    const existing = this.schedulers.get(row.id)
    if (existing && !existing.isStopped()) return

    const scheduler = new ClaimScheduler({
      getJwt: async () => this.credentialFor(row.id)?.jwt_token,
      createClient: (jwt) => createClaimClient({
        origin: this.origin(),
        jwt,
        appVersion: this.opts.config.appVersion,
        platform: `${process.platform}-${process.arch}`,
        deviceMid: this.deviceMid(row.id),
        fetchImpl: this.opts.fetcher,
      }),
      getCaptcha: () => this.opts.getCaptchaToken(),
      captchaRequired: this.opts.captchaRequired,
      config: {
        ...(this.opts.config.autoClaimPlanId ? { planId: this.opts.config.autoClaimPlanId } : {}),
        pollIntervalMs: this.opts.config.autoClaimPollMs,
        cooldownMs: this.opts.config.autoClaimCooldownMs,
      },
      log: (message) => {
        // Keep claim decisions visible without flooding the request log.
        this.opts.logger.info('claim', { account_id: row.id, message })
      },
      ...(this.opts.now ? { now: this.opts.now } : {}),
    })

    this.schedulers.set(row.id, scheduler)
    this.states.set(row.id, { accountId: row.id, running: true })
    scheduler.start()
  }

  /** Stop claiming for one account (e.g. deleted or disabled). */
  stopAccount(accountId: string): void {
    this.schedulers.get(accountId)?.stop()
    this.schedulers.delete(accountId)
    const state = this.states.get(accountId)
    if (state) state.running = false
  }

  stopAll(): void {
    for (const scheduler of this.schedulers.values()) scheduler.stop()
    this.schedulers.clear()
    for (const state of this.states.values()) state.running = false
  }

  /** Snapshot for the health/manifest surface and the manual-claim action. */
  list(): ClaimState[] {
    return [...this.states.values()]
  }

  /**
   * Claim once, synchronously, for one account (the `claim-plan` action).
   * Returns the raw outcome so an operator can see *why* a claim failed.
   */
  async claimOnce(accountId: string, planId?: string): Promise<ClaimOutcome> {
    const credential = this.credentialFor(accountId)
    if (!credential?.jwt_token) {
      return { ok: false, planId: planId ?? '', failureKind: 'login_required', code: 401, message: 'account has no usable credential' }
    }
    const client = createClaimClient({
      origin: this.origin(),
      jwt: credential.jwt_token,
      appVersion: this.opts.config.appVersion,
      platform: `${process.platform}-${process.arch}`,
      deviceMid: this.deviceMid(accountId),
      fetchImpl: this.opts.fetcher,
    })

    let targetPlanId = planId?.trim()
    if (!targetPlanId) {
      const plans = await client.listPlans()
      if (plans.length === 0) {
        return { ok: false, planId: '', failureKind: 'not_found', code: 1001, message: 'no claimable plan in the current campaign' }
      }
      const sorted = [...plans].sort((a, b) => b.priority - a.priority)
      targetPlanId = sorted[0]!.planId
    }

    let captcha: { verifyParam: string; region?: string } | undefined
    try {
      captcha = await this.opts.getCaptchaToken()
    } catch (err) {
      return {
        ok: false, planId: targetPlanId, failureKind: 'captcha', code: 3007,
        message: `captcha token unavailable: ${(err as Error).message}`,
      }
    }

    const outcome = await client.claim(targetPlanId, captcha)
    this.states.set(accountId, {
      accountId,
      running: this.schedulers.has(accountId),
      lastOutcome: outcome,
    })
    return outcome
  }

  /** Stable per-account device id for the campaign-gated `X-Device-Mid`. */
  private deviceMid(accountId: string): string | undefined {
    const key = `claim:deviceMid:${accountId}`
    const existing = this.opts.store.kvGet(key)
    if (existing) return existing
    const generated = crypto.randomUUID()
    this.opts.store.kvSet(key, generated)
    return generated
  }

  private credentialFor(accountId: string): ZCodeCredentialRecord | undefined {
    const credential = this.opts.store.getCredential(accountId)
    if (!credential?.jwt_token) return undefined
    return credential
  }

  private origin(): string {
    // apiBase is `https://zcode.z.ai/api/v1`; the claim plane lives at the root.
    try {
      return new URL(this.opts.config.upstreamApiBase).origin
    } catch {
      return 'https://zcode.z.ai'
    }
  }
}
