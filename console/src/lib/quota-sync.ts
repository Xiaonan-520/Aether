/**
 * Trigger one account-scoped quota sync and follow its scheduler job.
 *
 * Manual quota syncs go through the core job queue (never directly to the
 * extension). The scheduler tick can take up to a minute, so the UI polls the
 * job id for a bounded window and then refreshes the provider's quota view.
 * This is not a permanent background poll: it lives only for the duration of
 * one explicit user action.
 */
import { api, type ClaimJob } from './api'

export type QuotaSyncStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed'

export interface QuotaSyncState {
  status: QuotaSyncStatus
  error?: string
}

export interface QuotaSyncOptions {
  onState?: (state: QuotaSyncState) => void
  /** stop quietly when the owning component unmounts */
  shouldStop?: () => boolean
  timeoutMs?: number
  pollIntervalMs?: number
}

export interface QuotaSyncResult {
  ok: boolean
  job?: ClaimJob
  error?: string
  stopped?: boolean
}

const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_POLL_INTERVAL_MS = 1_500

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function triggerQuotaSyncAndWait(
  accountId: string,
  options: QuotaSyncOptions = {},
): Promise<QuotaSyncResult> {
  const { onState, shouldStop } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const { jobId } = await api.triggerJob(accountId, 'quota-sync')
  onState?.({ status: 'queued' })

  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (shouldStop?.()) return { ok: false, stopped: true, error: 'Quota sync cancelled' }

    const { jobs } = await api.jobs('quota_sync')
    const job = jobs.find((item) => item.id === jobId)

    if (job?.status === 'done') {
      onState?.({ status: 'done' })
      return { ok: true, job }
    }
    if (job?.status === 'failed' || job?.status === 'cancelled') {
      const error =
        job.error ?? (job.status === 'cancelled' ? 'Quota sync was cancelled' : 'Quota sync failed')
      onState?.({ status: 'failed', error })
      return { ok: false, job, error }
    }
    if (job?.status === 'running') onState?.({ status: 'running' })

    if (Date.now() >= deadline) {
      const error = `Quota sync did not finish within ${Math.round(
        timeoutMs / 1000,
      )}s; the last known snapshot is unchanged.`
      onState?.({ status: 'failed', error })
      return { ok: false, error }
    }

    await delay(pollIntervalMs)
  }
}
