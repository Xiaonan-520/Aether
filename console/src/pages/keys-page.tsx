/**
 * API Keys management page. Lists issued gateway keys (redacted metadata
 * only), creates new keys and revokes existing ones.
 *
 * Security model: the full key exists ONLY in the create-dialog component
 * state while the dialog is open — it is never written to storage, never
 * logged and never placed in a URL. After the dialog closes, only the
 * keyPrefix remains visible. Backend authorization is the admin token on
 * /api/keys; the UI merely surfaces what the server already enforces.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Copy, KeyRound, Plus } from 'lucide-react'
import { api, ApiError, type ApiKeyView, type CreatedApiKey } from '@/lib/api'
import { useQuery } from '@/lib/use-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

function formatTime(ts: number | null): string {
  if (ts === null) return '—'
  return new Date(ts).toLocaleString()
}

export function KeysPage() {
  const query = useQuery(() => api.listKeys(), [])
  const [createOpen, setCreateOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyView | null>(null)
  const [busy, setBusy] = useState(false)

  const keys = query.data?.keys ?? []
  // expiry badges are judged against the fetch time (refreshed on every refetch),
  // so the render stays pure and the badge state is stable between refreshes
  const now = query.fetchedAt ?? 0

  const revoke = async () => {
    if (!revokeTarget) return
    setBusy(true)
    try {
      await api.revokeKey(revokeTarget.id)
      toast.success(`Key "${revokeTarget.name}" revoked`)
      setRevokeTarget(null)
      query.refetch()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Revoke failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">API Keys</h1>
          <p className="text-sm text-muted-foreground">
            Keys clients use on /v1/*. The bootstrap GATEWAY_API_KEY keeps working and is not listed here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={query.refetch} disabled={query.loading}>
            {query.loading ? <Spinner data-icon="inline-start" /> : null}
            Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus data-icon="inline-start" />
            New key
          </Button>
        </div>
      </div>

      {query.error ? (
        <Alert variant="destructive">
          <AlertTitle>Failed to load keys</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{query.error.message}</span>
            <Button size="sm" variant="outline" onClick={query.refetch}>Retry</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {query.loading && keys.length === 0 ? (
        <Card className="py-6"><CardContent className="flex justify-center py-6"><Spinner /></CardContent></Card>
      ) : keys.length === 0 && !query.error ? (
        <Card className="py-6"><CardContent className="flex justify-center py-6">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No API keys issued</EmptyTitle>
              <EmptyDescription>
                Create a key to let a client call /v1/chat/completions and /v1/models with its own credential.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent></Card>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Created by</TableHead>
                <TableHead className="hidden md:table-cell">Created</TableHead>
                <TableHead className="hidden md:table-cell">Last used</TableHead>
                <TableHead className="hidden lg:table-cell">Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <KeyRow key={k.id} record={k} onRevoke={() => setRevokeTarget(k)} busy={busy} now={now} />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => query.refetch()}
      />

      <AlertDialog open={revokeTarget !== null} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API key</AlertDialogTitle>
            <AlertDialogDescription>
              "{revokeTarget?.name}" ({revokeTarget?.keyPrefix}…) will stop authenticating immediately.
              This cannot be undone — create a new key to replace it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                void revoke()
              }}
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function KeyRow({ record, onRevoke, busy, now }: { record: ApiKeyView; onRevoke: () => void; busy: boolean; now: number }) {
  const revoked = record.revokedAt !== null
  const expired = record.expiresAt !== null && record.expiresAt <= now
  return (
    <TableRow>
      <TableCell className="font-medium">{record.name}</TableCell>
      <TableCell className="font-mono text-xs">{record.keyPrefix}…</TableCell>
      <TableCell>
        {revoked ? (
          <Badge variant="outline" className="text-muted-foreground">revoked</Badge>
        ) : expired ? (
          <Badge variant="outline" className="border-warning/25 bg-warning/12 text-warning">expired</Badge>
        ) : record.enabled ? (
          <Badge variant="outline" className="border-success/25 bg-success/12 text-success">active</Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">disabled</Badge>
        )}
      </TableCell>
      <TableCell className="hidden lg:table-cell text-muted-foreground">
        {record.createdBy ?? 'static token'}
      </TableCell>
      <TableCell className="hidden md:table-cell text-muted-foreground">{formatTime(record.createdAt)}</TableCell>
      <TableCell className="hidden md:table-cell text-muted-foreground">{formatTime(record.lastUsedAt)}</TableCell>
      <TableCell className="hidden lg:table-cell text-muted-foreground">{formatTime(record.expiresAt)}</TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          disabled={busy || revoked}
          onClick={onRevoke}
        >
          Revoke
        </Button>
      </TableCell>
    </TableRow>
  )
}

/** One-shot key reveal: the key lives in this component state only, while open. */
function CreateKeyDialog({ open, onOpenChange, onCreated }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [expiresInDays, setExpiresInDays] = useState('')
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    // drop the plaintext key the moment the dialog leaves the screen
    setCreated(null)
    setName('')
    setExpiresInDays('')
    setError(null)
    onOpenChange(false)
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const days = Number(expiresInDays)
      const expiresAt = Number.isFinite(days) && days > 0
        ? Date.now() + days * 86_400_000
        : undefined
      const result = await api.createKey({
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      })
      setCreated(result)
      onCreated()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Create failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="size-4 text-success" />
                Key created
              </DialogTitle>
              <DialogDescription>
                Copy it now — this is the ONLY time the full key is shown. It is stored
                server-side as a hash and cannot be retrieved again.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-2.5 py-2 font-mono text-xs select-all">
                {created.key}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(created.key)
                    toast.success('Key copied to clipboard')
                  } catch {
                    toast.error('Clipboard unavailable — copy it manually')
                  }
                }}
              >
                <Copy data-icon="inline-start" />
                Copy
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={close}>Done — I saved the key</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                The key authenticates OpenAI-compatible clients on /v1/*. It is shown once at creation.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  placeholder="e.g. pi-agent laptop"
                  value={name}
                  maxLength={120}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="key-expiry">Expires in (days, empty = never)</Label>
                <Input
                  id="key-expiry"
                  type="number"
                  min="1"
                  placeholder="e.g. 90"
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value)}
                />
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
              <Button onClick={() => void create()} disabled={busy}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                Create key
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
