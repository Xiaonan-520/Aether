/**
 * Extensions management page (docs/EXTENSION_LIFECYCLE.md §5, M0 stage G).
 *
 * List view: every installed extension with its THREE states (install /
 * runtime / health) kept visibly separate, owned providers, and lifecycle
 * actions. Detail view: image provenance, operation history via lastError,
 * per-provider manifest actions rendered as dynamic forms driven purely by
 * the declared inputSchema — no provider-specific branches exist here.
 *
 * Safety model: remove keeps the data volume (the core offers no data
 * deletion); install/upgrade only offer trusted candidates from the core;
 * every destructive verb asks for confirmation.
 */
import * as React from 'react'
import { extensionsApi, ApiError } from '@/lib/api'
import type { ExtensionRecord, ManifestAction } from '@/lib/api'
import { useQuery } from '@/lib/use-query'
import {
  extensionNextAction,
  formatTime,
  healthState,
  installState,
  runtimeState,
  SEVERITY_CLASS,
} from '@/lib/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { ArrowLeftIcon, PackageIcon, PlusIcon, RefreshCwIcon } from 'lucide-react'

export function ExtensionsPage({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useQuery(() => extensionsApi.list(), [])
  const [confirm, setConfirm] = React.useState<
    { verb: 'stop' | 'restart' | 'remove'; id: string } | null
  >(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [installOpen, setInstallOpen] = React.useState(false)

  const runLifecycle = async () => {
    if (!confirm) return
    setBusy(true)
    setError(null)
    try {
      if (confirm.verb === 'stop') await extensionsApi.stop(confirm.id)
      else if (confirm.verb === 'restart') await extensionsApi.restart(confirm.id)
      else await extensionsApi.remove(confirm.id)
      setNotice(
        confirm.verb === 'remove'
          ? `${confirm.id} removed (data volume kept)`
          : `${confirm.id} ${confirm.verb} ok`,
      )
      setConfirm(null)
      list.refetch()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (list.loading) return <Centered><Spinner /></Centered>
  if (list.error) {
    return (
      <Notice
        tone="error"
        title="Extension manager unreachable"
        body={list.error.message}
      />
    )
  }
  const extensions = list.data?.extensions ?? []

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Extensions</h1>
          <p className="text-sm text-muted-foreground">
            Installable provider packs. Install / runtime / health are tracked separately.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            <RefreshCwIcon data-icon="inline-start" /> Refresh
          </Button>
          <Button size="sm" onClick={() => setInstallOpen(true)}>
            <PlusIcon data-icon="inline-start" /> Install
          </Button>
        </div>
      </header>

      {error ? <Notice tone="error" title="Operation failed" body={error} /> : null}
      {notice ? <Notice tone="ok" title="Done" body={notice} /> : null}

      {extensions.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            The extension manager reports no installed extensions. Installed packs appear here
            with their providers.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {extensions.map((ext) => (
            <ExtensionCard key={ext.extensionId} ext={ext} onOpen={onOpen} onAction={(verb) => setConfirm({ verb, id: ext.extensionId })} busy={busy} />
          ))}
        </div>
      )}

      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.verb === 'remove' ? 'Remove extension' : `${confirm?.verb} extension`}
            </DialogTitle>
            <DialogDescription>
              {confirm?.verb === 'remove'
                ? 'The container and manager record are deleted. The extension data volume is KEPT — credentials survive a re-install. Data deletion has no API by design.'
                : `Run "${confirm?.verb}" on ${confirm?.id}?`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button>
            <Button
              variant={confirm?.verb === 'remove' ? 'destructive' : 'default'}
              onClick={runLifecycle}
              disabled={busy}
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InstallDialog
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        onInstalled={(id) => {
          setInstallOpen(false)
          setNotice(`Extension "${id}" installed and registered.`)
          list.refetch()
        }}
      />
    </div>
  )
}

/**
 * Install an extension by naming its image.
 *
 * The core probes the image for the manifest it serves and runs the normal
 * install path, so the operator does not extract or paste JSON by hand
 * (KI-001). All validation still happens server-side: trusted repo prefix,
 * tag === manifest version, health check, conformance.
 */
function InstallDialog({
  open,
  onClose,
  onInstalled,
}: {
  open: boolean
  onClose: () => void
  onInstalled: (id: string) => void
}) {
  const [repo, setRepo] = React.useState('local/gateway-extension-')
  const [tag, setTag] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const reset = () => {
    setRepo('local/gateway-extension-')
    setTag('')
    setError(null)
    setBusy(false)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!repo.trim() || !tag.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await extensionsApi.installFromImage({ repo: repo.trim(), tag: tag.trim() })
      onInstalled(result.extensionId)
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset()
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install an extension</DialogTitle>
          <DialogDescription>
            Name the image. The gateway reads the manifest from the image, checks that its
            version matches the tag, starts the container, waits for it to become healthy and
            registers its providers.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ext-repo">Image repository</Label>
            <Input
              id="ext-repo"
              placeholder="local/gateway-extension-minimax"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              autoFocus
              disabled={busy}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ext-tag">Tag (must be an exact version)</Label>
            <Input
              id="ext-tag"
              placeholder="1.0.14"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              <code className="font-mono">latest</code> is refused — a tag pins what you install.
            </p>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {busy ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Pulling, starting and health-checking. This can take a minute.
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { reset(); onClose() }} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !repo.trim() || !tag.trim()}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Install
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ExtensionCard({ ext, onOpen, onAction, busy }: {
  ext: ExtensionRecord
  onOpen: (id: string) => void
  onAction: (verb: 'stop' | 'restart' | 'remove') => void
  busy: boolean
}) {
  const next = extensionNextAction(ext)
  const inst = installState(ext.installState)
  const run = runtimeState(ext.runtimeState)
  const health = healthState(ext.healthState)
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            className="min-w-0 text-left"
            onClick={() => onOpen(ext.extensionId)}
            aria-label={`Open ${ext.extensionId}`}
          >
            <CardTitle className="flex items-center gap-2 truncate text-base">
              <PackageIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{ext.extensionId}</span>
            </CardTitle>
            <CardDescription className="truncate">v{ext.version}</CardDescription>
          </button>
          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[inst.severity]}`}>
            {inst.label}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex flex-wrap gap-1.5 text-xs">
          <span className={`rounded-full border px-2 py-0.5 ${SEVERITY_CLASS[run.severity]}`}>runtime: {run.label}</span>
          <span className={`rounded-full border px-2 py-0.5 ${SEVERITY_CLASS[health.severity]}`}>health: {health.label}</span>
          {ext.providersRegistered ? (
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground">providers registered</span>
          ) : (
            <span className="rounded-full border border-warning/25 bg-warning/12 px-2 py-0.5 text-warning">not registered</span>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {ext.providers.length === 0 ? (
            <span className="text-xs text-muted-foreground">no providers declared</span>
          ) : (
            ext.providers.map((p) => (
              <Badge key={p} variant="secondary" className="font-mono text-xs">{p}</Badge>
            ))
          )}
        </div>

        {ext.lastError ? (
          <p className="line-clamp-2 text-xs text-destructive" title={ext.lastError}>{ext.lastError}</p>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={() => onOpen(ext.extensionId)}>Details</Button>
          {next === 'start' ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('restart')}>Start</Button>
          ) : null}
          {next === 'reload' ? null : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('restart')}>Restart</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('stop')}>Stop</Button>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => onAction('remove')}>
            Remove
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

export function ExtensionDetailPage({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useQuery(() => extensionsApi.detail(id), [id])
  const [reloadBusy, setReloadBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const doReload = async () => {
    setReloadBusy(true)
    setError(null)
    try {
      const res = await extensionsApi.reload(id)
      setNotice(`providers re-mounted: ${res.providers.join(', ') || 'none'}`)
      detail.refetch()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setReloadBusy(false)
    }
  }

  if (detail.loading) return <Centered><Spinner /></Centered>
  if (detail.error) return <Notice tone="error" title="Cannot load extension" body={detail.error.message} onBack={onBack} />
  const ext = detail.data!
  const inst = installState(ext.installState)
  const run = runtimeState(ext.runtimeState)
  const health = healthState(ext.healthState)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" /> All extensions
        </Button>
      </div>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            {ext.extensionId}
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[inst.severity]}`}>{inst.label}</span>
          </h1>
          <p className="text-sm text-muted-foreground">version {ext.version} · installed {formatTime(ext.installedAt)}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={reloadBusy} onClick={doReload}>
            {reloadBusy ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            Reload providers
          </Button>
        </div>
      </header>

      {error ? <Notice tone="error" title="Operation failed" body={error} /> : null}
      {notice ? <Notice tone="ok" title="Done" body={notice} /> : null}

      <Card>
        <CardHeader><CardTitle className="text-base">States</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <StateStat label="Install" view={inst} hint="manager record" />
          <StateStat label="Runtime" view={run} hint="live probe" />
          <StateStat label="Health" view={health} hint="extension /health" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Image &amp; providers</CardTitle>
          <CardDescription className="font-mono text-xs">{ext.image.repo}:{ext.image.tag}{ext.image.digest ? ` @ ${ext.image.digest.slice(0, 19)}…` : ''}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {ext.providers.map((p) => (
              <a
                key={p}
                href={`#/providers/${encodeURIComponent(p)}`}
                title={`Open ${p} in the Providers view`}
                className="transition-colors"
              >
                <Badge variant="secondary" className="font-mono hover:bg-primary/15">{p}</Badge>
              </a>
            ))}
          </div>
          <Separator />
          <p className="text-xs text-muted-foreground">
            {ext.providersRegistered
              ? 'All declared providers are mounted in the core registry.'
              : 'Declared providers are NOT all mounted — use "Reload providers" after an upgrade (the extension token rotates).'}
            {ext.providers.length > 0 ? ' Click a provider to inspect its models.' : ''}
          </p>
        </CardContent>
      </Card>

      {ext.lastError ? (
        <Card>
          <CardHeader><CardTitle className="text-base text-destructive">Last error</CardTitle></CardHeader>
          <CardContent><pre className="whitespace-pre-wrap break-words text-xs">{ext.lastError}</pre></CardContent>
        </Card>
      ) : null}

      {ext.providers.map((p) => (
        <ProviderActionsCard key={p} extensionId={ext.extensionId} providerId={p} />
      ))}
    </div>
  )
}

function StateStat({ label, view, hint }: { label: string; view: { label: string; severity: keyof typeof SEVERITY_CLASS }; hint: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 p-3">
      <span className="text-xs text-muted-foreground">{label} <span className="opacity-60">({hint})</span></span>
      <span className={`w-fit rounded-full border px-2 py-0.5 text-sm font-medium ${SEVERITY_CLASS[view.severity]}`}>{view.label}</span>
    </div>
  )
}

/**
 * Manifest-driven actions for one provider: the form is GENERATED from the
 * declared inputSchema (string/number/boolean properties + account_id), the
 * result rendered as JSON. No provider-specific UI branches.
 */
function ProviderActionsCard({ extensionId, providerId }: { extensionId: string; providerId: string }) {
  const actions = useQuery(() => extensionsApi.actions(extensionId, providerId), [extensionId, providerId])
  const [active, setActive] = React.useState<ManifestAction | null>(null)

  if (actions.loading) return <Card><CardContent className="py-6 text-center text-sm text-muted-foreground"><Spinner /></CardContent></Card>
  if (actions.error) {
    return <Card><CardContent className="py-6 text-sm text-muted-foreground">Actions unavailable: {actions.error.message}</CardContent></Card>
  }
  const declared = actions.data?.actions ?? []
  if (declared.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Actions · <span className="font-mono">{providerId}</span></CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">This provider declares no interactive actions.</CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Actions · <span className="font-mono">{providerId}</span></CardTitle>
        <CardDescription>Forms are generated from the manifest inputSchema; payloads go to the extension unmodified.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {declared.map((a) => (
          <Button key={a.id} size="sm" variant="outline" onClick={() => setActive(a)}>
            {a.title ?? a.id}
            {a.sideEffects === 'mutating' ? <span className="ml-1.5 text-xs text-warning">*</span> : null}
          </Button>
        ))}
      </CardContent>
      <ActionDialog action={active} extensionId={extensionId} providerId={providerId} onClose={() => setActive(null)} />
    </Card>
  )
}

/** Naive JSON-schema form: covers the primitives the manifest actions use. */
function ActionDialog({ action, extensionId, providerId, onClose }: {
  action: ManifestAction | null
  extensionId: string
  providerId: string
  onClose: () => void
}) {
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [accountId, setAccountId] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<unknown>(null)
  const [actionId, setActionId] = React.useState<string | null>(null)

  // reset form state when a different action opens (derived during render
  // instead of a setState-in-effect, which the lint rules forbid)
  if (action?.id !== actionId) {
    setActionId(action?.id ?? null)
    setValues({})
    setAccountId('')
    setError(null)
    setResult(null)
  }

  const props = objectProperties(action?.inputSchema)

  const submit = async () => {
    if (!action) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const payload: Record<string, unknown> = {}
      const propMap = new Map(props)
      for (const [key, raw] of Object.entries(values)) {
        if (raw === '') continue
        const type = propMap.get(key)?.type ?? 'string'
        payload[key] = type === 'number' || type === 'integer' ? Number(raw) : type === 'boolean' ? raw === 'true' : raw
      }
      const res = await extensionsApi.invokeAction(extensionId, providerId, action.id, {
        accountId: accountId || undefined,
        payload,
      })
      setResult(res.result)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={action !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[85svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{action?.title ?? action?.id}</DialogTitle>
          <DialogDescription>
            {action?.description ?? `Invoke "${action?.id}" on ${providerId}. Declared side effects: ${action?.sideEffects ?? 'unknown'}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="action-account">Account id (optional)</Label>
            <Input id="action-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="defaults to the extension's first account" />
          </div>
          {props.map(([key, prop]) => (
            <div key={key} className="flex flex-col gap-1.5">
              <Label htmlFor={`action-${key}`}>{key}{isRequired(action?.inputSchema, key) ? ' *' : ''}</Label>
              {prop.type === 'boolean' ? (
                <select
                  id={`action-${key}`}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  value={values[key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                >
                  <option value="">—</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <Input
                  id={`action-${key}`}
                  type={prop.type === 'number' || prop.type === 'integer' ? 'number' : 'text'}
                  value={values[key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                  placeholder={typeof prop.description === 'string' ? prop.description : undefined}
                />
              )}
            </div>
          ))}
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          {result !== null ? (
            <div className="rounded-md border border-border/60 bg-muted/40 p-3">
              <p className="mb-1 text-xs text-muted-foreground">Result</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(result, null, 2)}</pre>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Invoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function objectProperties(schema: Record<string, unknown> | undefined): Array<[string, { type?: string; description?: string }]> {
  if (!schema || typeof schema !== 'object') return []
  const props = (schema as { properties?: Record<string, { type?: string; description?: string }> }).properties
  if (!props) return []
  return Object.entries(props)
}

function isRequired(schema: Record<string, unknown> | undefined, key: string): boolean {
  const req = (schema as { required?: string[] } | undefined)?.required
  return Array.isArray(req) && req.includes(key)
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-center py-16">{children}</div>
}

function Notice({ tone, title, body, onBack }: { tone: 'ok' | 'error'; title: string; body?: string; onBack?: () => void }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm ${
        tone === 'error'
          ? 'border-destructive/25 bg-destructive/12 text-destructive'
          : 'border-success/25 bg-success/12 text-success'
      }`}
    >
      <span className="font-medium">{title}</span>
      {body ? <span className="min-w-0 break-words">{body}</span> : null}
      {onBack ? <Button size="sm" variant="outline" className="ml-auto" onClick={onBack}>Back</Button> : null}
    </div>
  )
}

export { PlusIcon }
