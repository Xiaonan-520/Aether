/**
 * Home page: gateway overview + provider card grid. All data comes from
 * GET /api/console/overview — the provider list is whatever the core has
 * registered, so new providers appear without any UI change.
 */
import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { toast } from 'sonner'
import { api, ApiError, type ConsoleProvider } from '@/lib/api'
import { useQuery } from '@/lib/use-query'
import { formatTime, rollUpAccounts, formatReset } from '@/lib/status'
import { summarizeQuotas, type QuotaSummary } from '@/lib/quota-display'
import { StatusBadge, StatusDot, DataPoint } from '@/components/console/status'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  ArrowRightIcon,
  BoxIcon,
  CoinsIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  ServerIcon,
  TriangleAlertIcon,
} from 'lucide-react'

const STALE_AFTER_MS = 90_000
const AUTO_REFRESH_MS = 60_000

export function HomePage() {
  const [now, setNow] = useState(() => Date.now())

  const query = useQuery(() => api.overview(), [])
  const [refreshing, setRefreshing] = useState(false)

  // quiet auto-refresh: background revalidation, no page-level animation
  useEffect(() => {
    const id = setInterval(() => {
      query.refetch()
    }, AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [query])

  // re-render relative timestamps every 30s
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const manualRefresh = async () => {
    setRefreshing(true)
    try {
      await api.overview()
      query.refetch()
      toast.success('Overview refreshed')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const overview = query.data
  const stale =
    query.fetchedAt !== null && now - query.fetchedAt > STALE_AFTER_MS && !query.loading

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Providers</h1>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              {query.loading && !overview ? (
                'Loading…'
              ) : (
                <>
                  <span>Updated {formatTime(query.fetchedAt, now)}</span>
                  {stale ? <Badge variant="outline" className="text-warning">stale</Badge> : null}
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={manualRefresh} disabled={refreshing || query.loading}>
              {refreshing ? <SpinnerIcon /> : <RefreshCwIcon />}
              Refresh
            </Button>
          </div>
        </div>

        {query.error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Could not load the overview</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span>{query.error.message}</span>
              <Button variant="outline" size="sm" onClick={query.refetch}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {query.loading && !overview ? <OverviewSkeleton /> : null}

        {overview ? (
          <>
            <OverviewStats
              totals={overview.totals}
              generatedAt={overview.generatedAt}
              stale={stale}
            />
            <Separator />
            {overview.providers.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ServerIcon />
                  </EmptyMedia>
                  <EmptyTitle>No providers registered</EmptyTitle>
                  <EmptyDescription>
                    The gateway core has no provider adapters registered. Install an extension or
                    check the core bootstrap logs — the console lists whatever the registry exposes.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {overview.providers.map((p, i) => (
                  <ProviderCard
                    key={p.id}
                    provider={p}
                    index={i}
                    reduced={prefersReducedMotionOnce()}
                  />
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>
    </TooltipProvider>
  )
}

let reducedMotionCache: boolean | null = null
function prefersReducedMotionOnce(): boolean {
  if (reducedMotionCache === null && typeof window !== 'undefined') {
    reducedMotionCache = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }
  return reducedMotionCache ?? false
}

function SpinnerIcon() {
  return (
    <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

function OverviewStats({
  totals,
  generatedAt,
  stale,
}: {
  totals: {
    providers: number
    accounts: number
    accountsAvailable: number
    models: number
    claimsToday: { success: number; failed: number }
  }
  generatedAt: number
  stale: boolean
}) {
  const claimSeverity =
    totals.claimsToday.failed > 0 ? 'warn' : totals.claimsToday.success > 0 ? 'ok' : 'neutral'
  const claimLabel =
    totals.claimsToday.success + totals.claimsToday.failed === 0
      ? 'No attempts today'
      : `${totals.claimsToday.success} ok · ${totals.claimsToday.failed} failed`

  const items: Array<{
    label: string
    value: string | number
    icon: typeof ServerIcon
    hint?: string
    severity?: 'ok' | 'warn' | 'neutral'
  }> = [
    { label: 'Providers', value: totals.providers, icon: ServerIcon },
    {
      label: 'Accounts available',
      value: `${totals.accountsAvailable} of ${totals.accounts}`,
      icon: KeyRoundIcon,
      hint: 'Enabled + authenticated + routable. Logged-in alone does not imply available.',
    },
    { label: 'Models', value: totals.models, icon: BoxIcon },
    {
      label: 'Auto claim today',
      value: claimLabel,
      icon: CoinsIcon,
      hint: 'Attempts recorded by the scheduler today; a claim being enabled does not mean it succeeded.',
      severity: claimSeverity as 'ok' | 'warn' | 'neutral',
    },
  ]

  return (
    <section aria-label="Gateway overview" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map(({ label, value, icon: Icon, hint, severity }) => (
        <Card key={label} className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Icon className="size-3.5" />
              {label}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <div className="nums text-lg font-semibold tracking-tight">{value}</div>
            {hint ? (
              <p className={`mt-1 text-xs ${severity === 'warn' ? 'text-warning' : 'text-muted-foreground'}`}>
                {hint}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ))}
      <p className="col-span-2 text-xs text-muted-foreground lg:col-span-4">
        Snapshot taken {formatTime(generatedAt)} · {stale ? 'older than expected — the core may be busy' : 'auto-refreshes every minute'}
      </p>
    </section>
  )
}

function ProviderCard({
  provider,
  index,
  reduced,
}: {
  provider: ConsoleProvider
  index: number
  reduced: boolean
}) {
  const roll = rollUpAccounts(provider.accounts)
  const quotaSummary = summarizeQuotas(provider.quotas)
  const claim = provider.claim
  const claimSupported = provider.capabilities.supportsCredits === true

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.3), ease: 'easeOut' }}
    >
      <Card className="flex h-full flex-col gap-4 transition-colors hover:border-ring/40">
        <CardHeader className="gap-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-sm font-semibold uppercase text-secondary-foreground">
                {provider.id.slice(0, 2)}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{provider.displayName}</span>
                <span className="truncate font-mono text-xs font-normal text-muted-foreground">
                  {provider.id}
                </span>
              </span>
            </CardTitle>
            <StatusBadge label={roll.label} severity={roll.severity} />
          </div>
        </CardHeader>

        <CardContent className="grid grid-cols-3 gap-3 px-6">
          <DataPoint label="Accounts">
            {provider.accounts.available} of {provider.accounts.total}
          </DataPoint>
          <DataPoint label="Models">{provider.models.total}</DataPoint>
          <DataPoint label="Attention">
            {provider.accounts.needsAttention > 0 ? (
              <span className="text-warning">{provider.accounts.needsAttention}</span>
            ) : (
              '0'
            )}
          </DataPoint>

          <div className="col-span-3 flex min-w-0 flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Credits / quota</span>
            <QuotaSummaryLine
              summary={quotaSummary}
              supportsQuota={provider.capabilities.supportsQuota}
            />
          </div>

          <div className="col-span-3 flex min-w-0 flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Auto claim</span>
            {!claimSupported ? (
              <span className="text-sm text-muted-foreground">Not supported</span>
            ) : !claim.hasHistory ? (
              <span className="text-sm text-muted-foreground">
                Enabled in core — no attempt recorded yet
              </span>
            ) : (
              <span className="flex items-center gap-2 text-sm">
                <StatusDot
                  severity={
                    claim.lastOutcome?.kind === 'success'
                      ? 'ok'
                      : claim.lastOutcome?.kind === 'already_claimed'
                        ? 'ok'
                        : 'warn'
                  }
                />
                <span className="truncate">
                  {claim.lastOutcome?.kind ?? 'unknown'} · {formatTime(claim.lastAttemptAt)}
                </span>
              </span>
            )}
          </div>
        </CardContent>

        <CardFooter className="mt-auto border-t border-border/60 px-6 py-3">
          <a
            href={`#/providers/${encodeURIComponent(provider.id)}`}
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            Manage
            <ArrowRightIcon className="size-3.5" />
          </a>
        </CardFooter>
      </Card>
    </motion.div>
  )
}

/**
 * Compact provider-card quota summary. A single account keeps the original
 * one-line shape. Multiple accounts are summed only when their resource and
 * unit are comparable; unknown accounts are counted, never coerced to zero.
 */
function QuotaSummaryLine({
  summary,
  supportsQuota,
}: {
  summary: QuotaSummary
  supportsQuota: boolean
}) {
  if (summary.kind === 'none') {
    return (
      <span className="text-sm text-muted-foreground">
        {supportsQuota ? 'No quota data yet' : 'Not supported by this provider'}
      </span>
    )
  }

  if (summary.kind === 'single') {
    return (
      <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className={`nums font-medium ${summary.unknown ? 'text-muted-foreground' : ''}`}>
          {summary.value}
        </span>
        {summary.unknown ? null : (
          <span className="text-xs text-muted-foreground">
            {formatReset(summary.resetAt)} · {formatTime(summary.lastUpdatedAt)}
          </span>
        )}
      </span>
    )
  }

  if (summary.kind === 'aggregate') {
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="nums font-medium">{summary.value}</span>
          {summary.unit ? <span className="text-xs text-muted-foreground">{summary.unit}</span> : null}
          <span className="text-xs text-muted-foreground">
            {summary.accountCount} accounts
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          latest update {formatTime(summary.lastUpdatedAt)}
          {summary.resetAt ? ` · ${formatReset(summary.resetAt)}` : ''}
        </span>
        {summary.unknownCount > 0 ? (
          <span className="text-xs text-warning">
            {summary.unknownCount} unknown {summary.unknownCount === 1 ? 'account' : 'accounts'} —
            total covers known accounts only
          </span>
        ) : null}
      </div>
    )
  }

  if (summary.kind === 'unavailable') {
    return (
      <span className="text-sm text-muted-foreground">
        Quota unknown for {summary.accountCount}{' '}
        {summary.accountCount === 1 ? 'account' : 'accounts'}
      </span>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">
        {summary.accountCount} accounts · per-account quotas
      </span>
      {summary.items.map((item) => (
        <span
          key={item.accountId}
          className="flex min-w-0 items-baseline justify-between gap-3 text-sm"
        >
          <span className="truncate text-muted-foreground">{item.label}</span>
          <span className={`nums shrink-0 ${item.unknown ? 'text-muted-foreground' : ''}`}>
            {item.value}
            {item.unit ? ` ${item.unit}` : ''}
          </span>
        </span>
      ))}
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="gap-3 py-4">
            <CardContent className="flex flex-col gap-2 px-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-14" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="py-6">
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="h-4 w-28" />
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
