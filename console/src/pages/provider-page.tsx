/**
 * Provider detail page. Four tabs (Accounts / Models / Credits / Auto claim);
 * every section renders real core data and marks unsupported features
 * explicitly instead of showing dead controls.
 */
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError, type Account, type BeginLoginResult, type ConsoleProvider } from '@/lib/api'
import { useQuery } from '@/lib/use-query'
import { accountStatus, formatQuota, formatReset, formatTime } from '@/lib/status'
import { StatusBadge, DataPoint } from '@/components/console/status'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Spinner } from '@/components/ui/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  ArrowLeftIcon,
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from 'lucide-react'

export function ProviderPage({ id, onBack }: { id: string; onBack: () => void }) {
  const overview = useQuery(() => api.overview(), [])
  const provider = overview.data?.providers.find((p) => p.id === id)

  if (overview.loading && !overview.data) {
    return <DetailSkeleton />
  }
  if (overview.error) {
    return (
      <LoadError
        message={overview.error.message}
        onRetry={overview.refetch}
        onBack={onBack}
      />
    )
  }
  if (!provider) {
    return (
      <LoadError
        message={`Provider "${id}" is not registered in the gateway core.`}
        onRetry={overview.refetch}
        onBack={onBack}
      />
    )
  }
  return <ProviderDetail provider={provider} onBack={onBack} />
}

function LoadError({
  message,
  onRetry,
  onBack,
}: {
  message: string
  onRetry: () => void
  onBack: () => void
}) {
  return (
    <div className="flex flex-col gap-6">
      <BackLink onBack={onBack} />
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>Provider view unavailable</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{message}</span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  )
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
      All providers
    </button>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-4 w-24" />
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-md" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <Skeleton className="h-9 w-96 max-w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

function ProviderDetail({ provider, onBack }: { provider: ConsoleProvider; onBack: () => void }) {
  const caps = provider.capabilities
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        <BackLink onBack={onBack} />

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-md bg-secondary text-base font-semibold uppercase text-secondary-foreground">
              {provider.id.slice(0, 2)}
            </span>
            <div className="flex min-w-0 flex-col">
              <h1 className="truncate text-lg font-semibold tracking-tight">
                {provider.displayName}
              </h1>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {provider.id} · login: {caps.loginMode} · {caps.protocol}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {caps.supportsQuota ? null : <Badge variant="outline">quota n/a</Badge>}
            {caps.supportsCredits ? null : <Badge variant="outline">claim n/a</Badge>}
            {caps.needsCaptcha ? <Badge variant="outline" className="text-warning">captcha handoff</Badge> : null}
          </div>
        </header>

        <Tabs defaultValue="accounts">
          <TabsList>
            <TabsTrigger value="accounts">
              Accounts
              {provider.accounts.needsAttention > 0 ? (
                <Badge variant="outline" className="ml-1.5 text-warning">
                  {provider.accounts.needsAttention}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="models">Models</TabsTrigger>
            <TabsTrigger value="credits">Credits / Quota</TabsTrigger>
            <TabsTrigger value="claim">Auto claim</TabsTrigger>
          </TabsList>

          <TabsContent value="accounts"><AccountsSection provider={provider} /></TabsContent>
          <TabsContent value="models"><ModelsSection providerId={provider.id} /></TabsContent>
          <TabsContent value="credits"><QuotaSection provider={provider} /></TabsContent>
          <TabsContent value="claim"><ClaimSection provider={provider} /></TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function AccountsSection({ provider }: { provider: ConsoleProvider }) {
  const query = useQuery(() => api.accounts(provider.id), [provider.id])
  const accounts = query.data?.accounts ?? []

  return (
    <div className="flex flex-col gap-4">
      <SectionToolbar
        description="Enabled + authenticated + routable accounts are what the router can actually use."
        onRefresh={query.refetch}
        loading={query.loading}
        extra={<StartLogin providerId={provider.id} />}
      />
      {query.error ? <SectionError message={query.error.message} onRetry={query.refetch} /> : null}
      {query.loading && accounts.length === 0 ? (
        <Card className="py-6"><CardContent className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </CardContent></Card>
      ) : null}
      {!query.loading && accounts.length === 0 && !query.error ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><KeyRoundIcon /></EmptyMedia>
            <EmptyTitle>No accounts for this provider</EmptyTitle>
            <EmptyDescription>
              Start a login to register the first account. The flow follows the provider's
              configured login mode ({provider.capabilities.loginMode}).
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {accounts.length > 0 ? (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Quota</TableHead>
                <TableHead className="hidden lg:table-cell">Last success</TableHead>
                <TableHead className="hidden lg:table-cell">Token expiry</TableHead>
                <TableHead className="w-px">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => (
                <AccountRow key={a.id} account={a} onChanged={query.refetch} />
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}
    </div>
  )
}

function AccountRow({ account, onChanged }: { account: Account; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const status = accountStatus(account.status)
  const quota = useMemo(() => {
    if (!account.quotaJson) return null
    try {
      return JSON.parse(account.quotaJson) as { known?: boolean; remaining?: number | null; total?: number | null; resetAt?: number | null }
    } catch {
      return null
    }
  }, [account.quotaJson])

  const run = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label)
    try {
      await fn()
      toast.success(ok)
      onChanged()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `${label} failed`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <TableRow>
      <TableCell className="max-w-48">
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{account.displayName}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{account.id}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <StatusBadge label={status.label} severity={status.severity} />
          {account.lastError ? (
            <span className="max-w-48 truncate text-xs text-destructive" title={account.lastError}>
              {account.lastError}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {quota && quota.known && (quota.remaining !== null || quota.total !== null) ? (
          <span className="nums text-sm">
            {formatQuota(quota.remaining ?? null, quota.total ?? null).value}
          </span>
        ) : account.lastQuotaAt ? (
          <span className="text-xs text-muted-foreground">snapshot, no numbers</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="hidden text-sm lg:table-cell">{formatTime(account.lastSuccessAt)}</TableCell>
      <TableCell className="hidden text-sm lg:table-cell">
        {account.tokenExpiryAt ? formatReset(account.tokenExpiryAt) : '—'}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            title="Enqueue token refresh (scheduler job)"
            disabled={busy !== null || !account.enabled}
            onClick={() => run('refresh', () => api.triggerJob(account.id, 'refresh'), 'Token refresh queued')}
          >
            {busy === 'refresh' ? <Spinner /> : <RefreshCwIcon />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Enqueue quota sync (scheduler job)"
            disabled={busy !== null || !account.enabled}
            onClick={() => run('quota', () => api.triggerJob(account.id, 'quota-sync'), 'Quota sync queued')}
          >
            {busy === 'quota' ? <Spinner /> : <span className="text-xs font-semibold">Q</span>}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              run('toggle', () => api.patchAccount(account.id, { enabled: !account.enabled }), account.enabled ? 'Account disabled' : 'Account enabled')
            }
          >
            {busy === 'toggle' ? <Spinner /> : account.enabled ? 'Disable' : 'Enable'}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button variant="ghost" size="sm" className="text-destructive" disabled={busy !== null}>
                  Remove
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove account {account.displayName}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This deletes the account and its stored credential on the gateway. It cannot be
                  undone — a new login is required to use it again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => run('remove', () => api.removeAccount(account.id), 'Account removed')}
                >
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </TableCell>
    </TableRow>
  )
}

function StartLogin({ providerId }: { providerId: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BeginLoginResult | null>(null)
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'success'>('idle')
  const [error, setError] = useState<string | null>(null)

  const begin = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.beginLogin(providerId)
      setResult(res)
      setPhase('waiting')
      // poll a few times so the operator sees completion without leaving
      const poll = setInterval(async () => {
        try {
          const status = await api.pollLogin(providerId, res.login_id)
          if (status.status === 'success') {
            clearInterval(poll)
            setPhase('success')
            toast.success(
              `Login completed${status.account && 'displayName' in status.account ? ` as ${String(status.account.displayName)}` : ''}`,
            )
          } else if (status.status === 'error') {
            clearInterval(poll)
            setError(status.error ?? 'Login did not complete')
          }
        } catch {
          clearInterval(poll)
        }
      }, Math.max(1000, (res.poll_interval ?? 2) * 1000))
      setTimeout(() => clearInterval(poll), 120_000)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login could not be started')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setResult(null) }}>
      <AlertDialogTrigger render={<Button size="sm">Add account</Button>} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Start login — {providerId}</AlertDialogTitle>
          <AlertDialogDescription>
            The gateway starts the provider's configured login flow. Complete the authorization in
            the opened page or URL, then wait here for the core to persist the credential.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {result && phase !== 'idle' ? (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
            {result.authorization_url ? (
              <a
                href={result.authorization_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
              >
                Open authorization page
                <ExternalLinkIcon className="size-3.5" />
              </a>
            ) : (
              <p className="text-xs text-muted-foreground">
                This provider's login flow has no URL — complete the steps in the provider's own
                app/site.
              </p>
            )}
            {phase === 'waiting' ? (
              <p className="text-xs text-muted-foreground">
                Waiting for completion (login {result.login_id})… the account appears when the core
                records it.
              </p>
            ) : null}
            {phase === 'success' ? (
              <p className="text-xs text-success">Login recorded by the core. Check the Accounts tab.</p>
            ) : null}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
          {!result ? (
            <Button onClick={begin} disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Begin login
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function ModelsSection({ providerId }: { providerId: string }) {
  const query = useQuery(() => api.providerModels(providerId), [providerId])
  const [search, setSearch] = useState('')
  const models = useMemo(() => query.data?.models ?? [], [query.data])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (m) =>
        m.modelId.toLowerCase().includes(q) ||
        m.upstreamModel.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q),
    )
  }, [models, search])

  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id)
      toast.success(`Copied ${id}`)
    } catch {
      toast.error('Clipboard unavailable')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionToolbar
        description="Exactly the registry entries the core routes on. exposedOnV1 = the id an OpenAI client sees on /v1/models."
        onRefresh={query.refetch}
        loading={query.loading}
        extra={
          <Input
            placeholder="Filter models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-40 sm:w-56"
          />
        }
      />
      {query.error ? <SectionError message={query.error.message} onRetry={query.refetch} /> : null}
      {query.loading && models.length === 0 ? (
        <Card className="py-6"><CardContent className="flex flex-col gap-3">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
        </CardContent></Card>
      ) : null}
      {!query.loading && filtered.length === 0 && !query.error ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{search ? 'No models match' : 'No models registered'}</EmptyTitle>
            <EmptyDescription>
              {search
                ? 'Try a different filter.'
                : 'Run POST /api/providers/' + providerId + '/sync-models once an account is authenticated.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {filtered.length > 0 ? (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model ID</TableHead>
                <TableHead className="hidden md:table-cell">Upstream</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead className="hidden sm:table-cell">/v1</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((m) => (
                <TableRow key={m.modelId}>
                  <TableCell className="max-w-56">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-mono text-sm font-medium">{m.modelId}</span>
                      <span className="truncate text-xs text-muted-foreground">{m.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden max-w-48 md:table-cell">
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {m.upstreamModel}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {m.capabilities.streaming ? <Badge variant="secondary">stream</Badge> : null}
                      {m.capabilities.vision ? <Badge variant="secondary">vision</Badge> : null}
                      {m.capabilities.toolCall ? <Badge variant="secondary">tools</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {m.enabled && m.exposedOnV1 ? (
                      <Badge variant="outline" className="text-success">exposed</Badge>
                    ) : m.enabled ? (
                      <Badge variant="outline">enabled</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">off</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={`Copy ${m.modelId}`}
                      onClick={() => copy(m.modelId)}
                    >
                      <CopyIcon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Credits / Quota
// ---------------------------------------------------------------------------

function QuotaSection({ provider }: { provider: ConsoleProvider }) {
  if (!provider.capabilities.supportsQuota) {
    return <Unsupported feature="Quota / credits reporting" />
  }
  if (provider.quotas.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No quota data</EmptyTitle>
          <EmptyDescription>
            Add an account and run a quota sync — snapshots appear per account here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {provider.quotas.map((q) => {
        const { value } = formatQuota(q.remaining, q.total)
        return (
          <Card key={q.accountId} className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{q.accountDisplayName}</span>
                <Badge variant="outline">{q.known ? 'provider quota API' : 'unknown quota'}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 px-4">
              <div className="nums text-2xl font-semibold tracking-tight">
                {q.known ? value : <span className="text-muted-foreground">Unknown</span>}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>updated {formatTime(q.lastUpdatedAt)}</span>
                {q.resetAt ? <span>{formatReset(q.resetAt)}</span> : <span>no reset info from upstream</span>}
                {q.lastUpdatedAt === null ? <span className="text-warning">never synced — run a quota sync</span> : null}
              </div>
              {q.raw !== null && q.raw !== undefined ? (
                <>
                  <Separator className="my-1" />
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none hover:text-foreground">
                      Raw upstream snapshot
                    </summary>
                    <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
                      {JSON.stringify(q.raw, null, 2)}
                    </pre>
                  </details>
                </>
              ) : null}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Auto claim
// ---------------------------------------------------------------------------

function ClaimSection({ provider }: { provider: ConsoleProvider }) {
  const query = useQuery(() => api.providerClaims(provider.id), [provider.id])
  const jobs = query.data?.claims ?? []
  const claim = provider.claim

  if (!provider.capabilities.supportsCredits) {
    return <Unsupported feature="Automatic credit claim" />
  }

  const recent = jobs.slice(0, 10)
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="gap-3 py-4">
          <CardContent className="px-4">
            <DataPoint label="Scheduler job">credit_claim (core-managed)</DataPoint>
            <p className="mt-1 text-xs text-muted-foreground">
              The console does not trigger real check-ins directly — the scheduler owns polling,
              idempotency and concurrency.
            </p>
          </CardContent>
        </Card>
        <Card className="gap-3 py-4">
          <CardContent className="px-4">
            <DataPoint label="Latest recorded outcome">
              {claim.hasHistory ? (
                <span className="flex items-center gap-2">
                  {claim.lastOutcome?.kind ?? 'unknown'}
                  {claim.lastOutcome?.credit !== undefined ? (
                    <span className="text-success">+{claim.lastOutcome.credit}</span>
                  ) : null}
                </span>
              ) : (
                <span className="text-muted-foreground">No attempt recorded</span>
              )}
            </DataPoint>
            <p className="mt-1 text-xs text-muted-foreground">
              {claim.lastAttemptAt ? formatTime(claim.lastAttemptAt) : 'The scheduler has not attempted a claim for this provider yet.'}
            </p>
          </CardContent>
        </Card>
        <Card className="gap-3 py-4">
          <CardContent className="px-4">
            <DataPoint label="Job history (latest 10)">
              {jobs.length > 0 ? `${jobs.length} recorded` : '—'}
            </DataPoint>
            <p className="mt-1 text-xs text-muted-foreground">From the core job queue, not from the browser.</p>
          </CardContent>
        </Card>
      </div>

      {recent.length > 0 ? (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Scheduled</TableHead>
                <TableHead className="hidden md:table-cell">Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((j) => {
                const result = j.resultJson ? safeParse(j.resultJson) : null
                return (
                  <TableRow key={j.id}>
                    <TableCell className="max-w-40 truncate font-mono text-xs">{j.accountId ?? '—'}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          j.status === 'done'
                            ? 'text-success'
                            : j.status === 'failed'
                              ? 'text-destructive'
                              : 'text-muted-foreground'
                        }
                      >
                        {j.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden text-sm md:table-cell">{formatTime(j.scheduledAt)}</TableCell>
                    <TableCell className="hidden max-w-56 truncate text-xs text-muted-foreground md:table-cell">
                      {result ? JSON.stringify(result) : (j.error ?? '—')}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          No credit_claim jobs recorded for this provider yet. They appear once the scheduler runs
          them (every 30 minutes when the provider supports claiming).
        </p>
      )}
    </div>
  )
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function Unsupported({ feature }: { feature: string }) {
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>{feature} — not supported</AlertTitle>
      <AlertDescription>
        This provider's adapter does not declare this capability in the core registry, so the
        console shows no controls for it. No fake buttons.
      </AlertDescription>
    </Alert>
  )
}

function SectionToolbar({
  description,
  onRefresh,
  loading,
  extra,
}: {
  description: string
  onRefresh: () => void
  loading: boolean
  extra?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      <div className="flex items-center gap-2">
        {extra}
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          Refresh
        </Button>
      </div>
    </div>
  )
}

function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>Request failed</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{message}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  )
}
