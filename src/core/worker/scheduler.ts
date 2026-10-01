/**
 * Background scheduler: a job-table driven worker loop.
 *
 * Design (per DESIGN_PHASE2 §6):
 * - every task runs through the jobs table (idempotency + audit);
 * - failures retry with exponential backoff (base 1m, cap 30m) via a
 *   re-scheduled job; terminal errors park the account instead;
 * - concurrency is capped globally and per provider so background work never
 *   floods upstreams;
 * - the loop ticks once a minute and pulls due jobs; nothing runs in request
 *   paths.
 */
import { randomUUID } from 'node:crypto'
import type { Account } from '../types.js'
import type { Job } from '../../store/types.js'
import type { StoreGateway } from '../../store/types.js'
import type { ProviderRegistry } from '../registry/provider-registry.js'
import type { UpstreamError } from '../errors/upstream-error.js'
import { retryDelayMs } from '../errors/upstream-error.js'

export type JobType = 'token_refresh' | 'quota_sync' | 'credit_claim' | 'health_check'

export interface SchedulerOptions {
  store: StoreGateway
  registry: ProviderRegistry
  /** claim idempotency + date keying live in the store */
  now?: () => number
  /** ms between due-job sweeps (default 60_000) */
  tickIntervalMs?: number
  /** max jobs executing concurrently (default 4) */
  maxConcurrent?: number
  /** token refresh lead time: refresh when expiry - now <= this (default 1h) */
  refreshLeadMs?: number
  logger?: (level: string, message: string, extra?: Record<string, unknown>) => void
}

/** Enqueue window generators used by the built-in recurring scans. */
interface ScanDefinition {
  jobType: JobType
  /** how often a scan enqueues new due jobs (ms) */
  intervalMs: number
  eligible: (account: Account, now: number, opts: SchedulerOptions) => boolean
}

const SCANS: ScanDefinition[] = [
  {
    jobType: 'token_refresh',
    intervalMs: 5 * 60_000,
    eligible: (a, now, opts) =>
      a.enabled &&
      a.refreshable &&
      a.tokenExpiryAt !== null &&
      a.tokenExpiryAt - now <= (opts.refreshLeadMs ?? 3_600_000),
  },
  {
    jobType: 'quota_sync',
    intervalMs: 15 * 60_000,
    eligible: (a) => a.enabled && a.status !== 'needs_manual_action',
  },
  {
    jobType: 'credit_claim',
    intervalMs: 24 * 3_600_000,
    eligible: (a) => a.enabled && a.status !== 'needs_manual_action',
  },
  {
    jobType: 'health_check',
    intervalMs: 30 * 60_000,
    eligible: (a) => a.enabled,
  },
]

export class Scheduler {
  private readonly store: StoreGateway
  private readonly registry: ProviderRegistry
  private readonly opts: Required<Pick<SchedulerOptions, 'tickIntervalMs' | 'maxConcurrent' | 'refreshLeadMs'>> &
    SchedulerOptions
  private timer: NodeJS.Timeout | null = null
  private running = 0
  private lastScanAt = new Map<JobType, number>()
  private inFlight = new Set<string>()
  private stopping = false
  /** pluggable executors (mocked in tests; default implementations come with 3B adapters) */
  private readonly executors = new Map<JobType, (job: Job, account: Account) => Promise<unknown>>()

  constructor(opts: SchedulerOptions) {
    this.opts = {
      tickIntervalMs: opts.tickIntervalMs ?? 60_000,
      maxConcurrent: opts.maxConcurrent ?? 4,
      refreshLeadMs: opts.refreshLeadMs ?? 3_600_000,
      ...opts,
    }
    this.store = opts.store
    this.registry = opts.registry
  }

  /** Register (or replace) the executor for a job type. */
  setExecutor(jobType: JobType, exec: (job: Job, account: Account) => Promise<unknown>): void {
    this.executors.set(jobType, exec)
  }

  start(): void {
    if (this.timer) return
    this.stopping = false
    this.timer = setInterval(() => {
      void this.tick()
    }, this.opts.tickIntervalMs)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // wait for in-flight jobs (bounded)
    for (let i = 0; i < 100 && this.running > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** One scheduler sweep: scan + run due jobs. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.stopping) return
    const now = this.now()
    this.scanRecurring(now)
    const due = this.collectDueJobs(now)
    for (const job of due) {
      if (this.running >= this.opts.maxConcurrent) break
      if (this.inFlight.has(job.id)) continue
      this.inFlight.add(job.id)
      this.running++
      void this.runJob(job).finally(() => {
        this.inFlight.delete(job.id)
        this.running--
      })
    }
  }

  /** Enqueue jobs for accounts matching each scan's cadence. */
  private scanRecurring(now: number): void {
    for (const scan of SCANS) {
      const last = this.lastScanAt.get(scan.jobType) ?? 0
      if (now - last < scan.intervalMs) continue
      this.lastScanAt.set(scan.jobType, now)
      for (const stored of this.store.listAccounts()) {
        const account = stored.account
        if (!scan.eligible(account, now, this.opts)) continue
        // idempotency for daily claims is enforced by the store at execution;
        // job ids are unique per enqueue
        this.store.createJob({
          id: randomUUID(),
          provider: account.provider,
          accountId: account.id,
          jobType: scan.jobType,
          scheduledAt: now,
          startedAt: null,
          finishedAt: null,
          status: 'pending',
          error: null,
          resultJson: null,
          attempts: 0,
        })
      }
    }
  }

  private collectDueJobs(now: number): Job[] {
    const out: Job[] = []
    for (const scan of SCANS) {
      for (const job of this.store.nextDueJobs(scan.jobType, now)) {
        if (!this.inFlight.has(job.id)) out.push(job)
      }
    }
    return out
  }

  private async runJob(job: Job): Promise<void> {
    const now = this.now()
    this.store.updateJob(job.id, { status: 'running', startedAt: now })
    if (!job.accountId) {
      this.store.updateJob(job.id, { status: 'failed', error: 'job has no accountId', finishedAt: this.now() })
      return
    }
    const stored = this.store.getAccount(job.accountId)
    if (!stored) {
      this.store.updateJob(job.id, { status: 'cancelled', error: 'account removed', finishedAt: this.now() })
      return
    }
    const executor = this.executors.get(job.jobType as JobType)
    if (!executor) {
      // 3A ships the framework; adapters register real executors in 3B.
      this.store.updateJob(job.id, {
        status: 'cancelled',
        error: `no executor registered for ${job.jobType}`,
        finishedAt: this.now(),
      })
      return
    }

    try {
      const result = await executor(job, stored.account)
      this.store.updateJob(job.id, {
        status: 'done',
        finishedAt: this.now(),
        resultJson: result !== undefined ? JSON.stringify(result) : null,
        attempts: job.attempts + 1,
      })
    } catch (err) {
      const error = err as UpstreamError
      const attempts = job.attempts + 1
      const terminal = error instanceof Error && 'isTerminal' in error && (error as UpstreamError).isTerminal
      if (terminal) {
        // e.g. refresh token revoked: park the account for manual re-login
        this.store.patchAccount(stored.account.id, {
          status: 'needs_manual_action',
          lastError: error.message,
          updatedAt: this.now(),
        })
        this.store.updateJob(job.id, { status: 'failed', error: error.message, attempts, finishedAt: this.now() })
        return
      }
      // retry with exponential backoff
      const delay = retryDelayMs(error.kind ?? 'TRANSPORT', attempts)
      this.store.updateJob(job.id, {
        status: 'pending',
        error: error.message,
        attempts,
        scheduledAt: this.now() + delay,
      })
    }
  }

  /** Immediate manual enqueue (admin API). Returns the job id. */
  enqueue(jobType: JobType, accountId: string, provider: string): string {
    const id = randomUUID()
    this.store.createJob({
      id,
      provider,
      accountId,
      jobType,
      scheduledAt: this.now(),
      startedAt: null,
      finishedAt: null,
      status: 'pending',
      error: null,
      resultJson: null,
      attempts: 0,
    })
    return id
  }
}
