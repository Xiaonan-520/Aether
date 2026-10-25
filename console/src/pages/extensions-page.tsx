/**
 * Extensions management page (docs/EXTENSION_LIFECYCLE.md §5, M0 stage G).
 *
 * List view: every installed extension with its THREE states (install /
 * runtime / health) kept visibly separate, owned model services, and lifecycle
 * actions. Detail view: version/state summary, model services, operator-facing
 * error explanations, and per-provider manifest actions rendered as dynamic
 * forms driven purely by the declared inputSchema.
 *
 * Safety model: remove keeps the data volume (the core offers no data
 * deletion); install/upgrade only offer trusted candidates from the core;
 * every destructive verb asks for confirmation.
 *
 * Copy rule: this page is for operators, not extension authors. Container
 * addresses, manifests, conformance, token rotation and registry internals stay
 * behind the collapsed "technical details" blocks (or in the server logs).
 */
import * as React from 'react'
import { extensionsApi } from '@/lib/api'
import type { ExtensionRecord, ManifestAction } from '@/lib/api'
import { useQuery } from '@/lib/use-query'
import {
  extensionNextAction,
  healthState,
  installState,
  runtimeState,
  SEVERITY_CLASS,
  type StatusView,
} from '@/lib/status'
import {
  describeExtensionError,
  describeStoredError,
} from '@/lib/extension-errors'
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import {
  ArrowLeftIcon,
  PackageIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react'

type LifecycleVerb = 'start' | 'restart' | 'stop' | 'remove'

interface LifecycleRequest {
  verb: LifecycleVerb
  id: string
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

export function ExtensionsPage({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useQuery(() => extensionsApi.list(), [])
  const [confirm, setConfirm] = React.useState<LifecycleRequest | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [reloadingId, setReloadingId] = React.useState<string | null>(null)
  const [installOpen, setInstallOpen] = React.useState(false)

  const runLifecycle = async () => {
    if (!confirm) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (confirm.verb === 'start' || confirm.verb === 'restart') {
        await extensionsApi.restart(confirm.id)
      } else if (confirm.verb === 'stop') {
        await extensionsApi.stop(confirm.id)
      } else {
        await extensionsApi.remove(confirm.id)
      }
      setNotice(lifecycleNotice(confirm))
      setConfirm(null)
      list.refetch()
    } catch (err) {
      setError(err)
      // Close the confirmation so the explanation is not hidden behind the modal.
      setConfirm(null)
    } finally {
      setBusy(false)
    }
  }

  const reload = async (id: string) => {
    if (reloadingId) return
    setReloadingId(id)
    setError(null)
    setNotice(null)
    try {
      const res = await extensionsApi.reload(id)
      setNotice(`已重新加载扩展「${id}」的模型服务（${res.providers.length} 项）。`)
      list.refetch()
    } catch (err) {
      setError(err)
    } finally {
      setReloadingId(null)
    }
  }

  const extensions = list.data?.extensions ?? []
  const firstLoad = list.loading && !list.data

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">扩展管理</h1>
          <p className="text-sm text-muted-foreground">
            安装并管理扩展，以及它们提供的模型服务。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => list.refetch()}
            disabled={list.loading}
          >
            <RefreshCwIcon data-icon="inline-start" /> 刷新
          </Button>
          <Button size="sm" onClick={() => setInstallOpen(true)} disabled={firstLoad}>
            <PlusIcon data-icon="inline-start" /> 安装扩展
          </Button>
        </div>
      </header>

      {error ? (
        <ErrorNotice
          title="操作没有完成"
          explanation={describeExtensionError(error)}
          onDismiss={() => setError(null)}
        />
      ) : null}
      {notice ? <SuccessNotice text={notice} onDismiss={() => setNotice(null)} /> : null}

      {firstLoad ? <LoadingCard text="正在加载扩展列表…" /> : null}

      {!firstLoad && list.error ? (
        <ErrorNotice
          title="无法加载扩展列表"
          explanation={describeExtensionError(list.error, 'load')}
          onRetry={() => list.refetch()}
        />
      ) : null}

      {!firstLoad && list.data && list.data.skipped > 0 ? (
        <div
          role="status"
          className="rounded-lg border border-warning/25 bg-warning/12 p-3 text-sm text-warning"
        >
          有 {list.data.skipped} 条扩展记录无法读取，已跳过。请刷新；如果持续出现，请把这条信息提供给管理员。
        </div>
      ) : null}

      {!firstLoad && list.data && extensions.length === 0 ? (
        <EmptyExtensions onInstall={() => setInstallOpen(true)} />
      ) : null}

      {!firstLoad && extensions.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {extensions.map((ext) => (
            <ExtensionCard
              key={ext.extensionId}
              ext={ext}
              busy={busy || reloadingId === ext.extensionId}
              reloading={reloadingId === ext.extensionId}
              onOpen={onOpen}
              onReload={() => void reload(ext.extensionId)}
              onAction={(verb) => setConfirm({ verb, id: ext.extensionId })}
            />
          ))}
        </div>
      ) : null}

      <LifecycleDialog
        request={confirm}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={runLifecycle}
      />

      <InstallDialog
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        onInstalled={(id) => {
          setInstallOpen(false)
          setNotice(`扩展「${id}」已安装并接入网关。`)
          list.refetch()
        }}
      />
    </div>
  )
}

function ExtensionCard({
  ext,
  busy,
  reloading,
  onOpen,
  onReload,
  onAction,
}: {
  ext: ExtensionRecord
  busy: boolean
  reloading: boolean
  onOpen: (id: string) => void
  onReload: () => void
  onAction: (verb: 'start' | 'restart' | 'stop' | 'remove') => void
}) {
  const next = extensionNextAction(ext)
  const inst = installState(ext.installState)
  const run = runtimeState(ext.runtimeState)
  const health = healthState(ext.healthState)
  const storedError = ext.lastError ? describeStoredError(ext.lastError) : null
  const canRestart = ext.installState !== 'failed'
  const canStop = ext.runtimeState !== 'stopped' && ext.installState !== 'failed'

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            className="min-w-0 text-left"
            onClick={() => onOpen(ext.extensionId)}
            aria-label={`查看 ${ext.name} 的详情`}
          >
            <CardTitle className="flex items-center gap-2 truncate text-base">
              <PackageIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{ext.name}</span>
            </CardTitle>
            <CardDescription className="truncate">
              {ext.version ? `版本 ${ext.version}` : '版本未知'}
            </CardDescription>
          </button>
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[inst.severity]}`}
          >
            {inst.label}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex flex-wrap gap-1.5 text-xs">
          <span className={`rounded-full border px-2 py-0.5 ${SEVERITY_CLASS[run.severity]}`}>
            运行状态：{run.label}
          </span>
          <span className={`rounded-full border px-2 py-0.5 ${SEVERITY_CLASS[health.severity]}`}>
            健康状态：{health.label}
          </span>
          <span
            className={`rounded-full border px-2 py-0.5 ${
              ext.providersRegistered
                ? 'border-success/25 bg-success/12 text-success'
                : 'border-warning/25 bg-warning/12 text-warning'
            }`}
          >
            {ext.providersRegistered ? '服务已接入' : '服务未接入'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {ext.providers.length === 0 ? (
            <span className="text-xs text-muted-foreground">未提供模型服务</span>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">模型服务：</span>
              {ext.providers.map((p) => (
                <Badge key={p} variant="secondary" className="font-mono text-xs">
                  {p}
                </Badge>
              ))}
            </>
          )}
        </div>

        {storedError ? (
          <p className="line-clamp-2 text-xs text-destructive">{storedError.summary}</p>
        ) : null}
        {!ext.complete ? (
          <p className="text-xs text-warning">部分信息缺失，详情页会标明无法读取的项目。</p>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={() => onOpen(ext.extensionId)}>
            查看详情
          </Button>
          {next === 'start' ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('start')}>
              <PlayIcon data-icon="inline-start" /> 启动
            </Button>
          ) : null}
          {next === 'reload' ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={onReload}>
              {reloading ? <Spinner data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}
              重载服务
            </Button>
          ) : null}
          {next !== 'start' && canRestart ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('restart')}>
              重启
            </Button>
          ) : null}
          {canStop ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('stop')}>
              停止
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={busy}
            onClick={() => onAction('remove')}
          >
            移除
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function EmptyExtensions({ onInstall }: { onInstall: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <PackageIcon className="size-6 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">还没有安装扩展</p>
          <p className="text-sm text-muted-foreground">
            安装扩展后，它提供的模型服务会显示在这里。
          </p>
        </div>
        <Button size="sm" onClick={onInstall}>
          <PlusIcon data-icon="inline-start" /> 安装扩展
        </Button>
      </CardContent>
    </Card>
  )
}

/**
 * Install an extension by naming its image.
 *
 * The core probes the image for the extension information it serves and runs
 * the normal install path, so the operator does not extract or paste JSON by
 * hand. Validation stays server-side (trusted image source, version match,
 * start and health check).
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
  const [error, setError] = React.useState<unknown>(null)

  const reset = () => {
    setRepo('local/gateway-extension-')
    setTag('')
    setError(null)
    setBusy(false)
  }

  const close = () => {
    if (busy) return
    reset()
    onClose()
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
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const explanation = error ? describeExtensionError(error, 'install') : null

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>安装扩展</DialogTitle>
          <DialogDescription>
            填写扩展提供方给出的地址和版本号。网关会自动安装并启动扩展，全过程可能需要约一分钟。
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ext-repo">扩展包地址</Label>
            <Input
              id="ext-repo"
              placeholder="local/gateway-extension-minimax"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              autoFocus
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              由扩展提供方提供，通常以 <code className="font-mono">local/gateway-extension-</code> 开头。
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ext-tag">版本号</Label>
            <Input
              id="ext-tag"
              placeholder="1.0.14"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              请填写扩展提供方给出的明确版本号，不能使用 latest。
            </p>
          </div>
          {explanation ? (
            <div
              role="alert"
              className="flex flex-col gap-1 rounded-md border border-destructive/25 bg-destructive/12 p-2 text-sm text-destructive"
            >
              <span className="font-medium">{explanation.summary}</span>
              <span className="text-xs">{explanation.hint}</span>
              <TechnicalDetails detail={explanation.detail} />
            </div>
          ) : null}
          {busy ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> 正在下载并启动扩展，请稍候…
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={busy}>
              取消
            </Button>
            <Button type="submit" disabled={busy || !repo.trim() || !tag.trim()}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              安装
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

export function ExtensionDetailPage({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useQuery(() => extensionsApi.detail(id), [id])
  const [confirm, setConfirm] = React.useState<LifecycleRequest | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [reloading, setReloading] = React.useState(false)

  const runLifecycle = async () => {
    if (!confirm) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (confirm.verb === 'start' || confirm.verb === 'restart') {
        await extensionsApi.restart(confirm.id)
      } else if (confirm.verb === 'stop') {
        await extensionsApi.stop(confirm.id)
      } else {
        await extensionsApi.remove(confirm.id)
      }
      setNotice(lifecycleNotice(confirm))
      setConfirm(null)
      if (confirm.verb === 'remove') {
        onBack()
        return
      }
      detail.refetch()
    } catch (err) {
      setError(err)
      // Close the confirmation so the explanation is not hidden behind the modal.
      setConfirm(null)
    } finally {
      setBusy(false)
    }
  }

  const reload = async () => {
    if (reloading || !detail.data) return
    setReloading(true)
    setError(null)
    setNotice(null)
    try {
      const res = await extensionsApi.reload(detail.data.extensionId)
      setNotice(`已重新加载模型服务（${res.providers.length} 项）。`)
      detail.refetch()
    } catch (err) {
      setError(err)
    } finally {
      setReloading(false)
    }
  }

  if (detail.loading && !detail.data) return <DetailLoading onBack={onBack} />
  if (detail.error && !detail.data) {
    return (
      <div className="flex flex-col gap-6">
        <BackButton onBack={onBack} />
        <ErrorNotice
          title="无法打开扩展"
          explanation={describeExtensionError(detail.error, 'load')}
          onRetry={() => detail.refetch()}
          onBack={onBack}
        />
      </div>
    )
  }

  const ext = detail.data
  if (!ext) return <DetailLoading onBack={onBack} />

  const inst = installState(ext.installState)
  const run = runtimeState(ext.runtimeState)
  const health = healthState(ext.healthState)
  const next = extensionNextAction(ext)
  const storedError = ext.lastError ? describeStoredError(ext.lastError) : null
  const canRestart = ext.installState !== 'failed'
  const canStop = ext.runtimeState !== 'stopped' && ext.installState !== 'failed'
  const canReload = ext.installState === 'installed' && ext.runtimeState !== 'stopped'

  return (
    <div className="flex flex-col gap-6">
      <div>
        <BackButton onBack={onBack} />
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
            {ext.name}
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[inst.severity]}`}
            >
              {inst.label}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            版本 {ext.version ?? '未知'} · 安装于 {formatInstalledAt(ext.installedAt)}
          </p>
          {ext.name !== ext.extensionId ? (
            <p className="text-xs text-muted-foreground">扩展标识：<span className="font-mono">{ext.extensionId}</span></p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {next === 'start' ? (
            <Button size="sm" disabled={busy} onClick={() => setConfirm({ verb: 'start', id: ext.extensionId })}>
              <PlayIcon data-icon="inline-start" /> 启动
            </Button>
          ) : null}
          {next !== 'start' && canRestart ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm({ verb: 'restart', id: ext.extensionId })}
            >
              <RotateCwIcon data-icon="inline-start" /> 重启
            </Button>
          ) : null}
          {canStop ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm({ verb: 'stop', id: ext.extensionId })}
            >
              <SquareIcon data-icon="inline-start" /> 停止
            </Button>
          ) : null}
          {canReload ? (
            <Button
              size="sm"
              variant={ext.providersRegistered ? 'outline' : 'default'}
              disabled={busy || reloading}
              onClick={() => void reload()}
            >
              {reloading ? <Spinner data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}
              重载服务
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={busy}
            onClick={() => setConfirm({ verb: 'remove', id: ext.extensionId })}
          >
            <Trash2Icon data-icon="inline-start" /> 移除
          </Button>
        </div>
      </header>

      {error ? (
        <ErrorNotice
          title="操作没有完成"
          explanation={describeExtensionError(error)}
          onDismiss={() => setError(null)}
        />
      ) : null}
      {notice ? <SuccessNotice text={notice} onDismiss={() => setNotice(null)} /> : null}

      {!ext.complete ? (
        <Alert className="p-3">
          <TriangleAlertIcon />
          <AlertTitle>部分信息缺失</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>网关返回的扩展信息不完整，标为“未知”的项目暂时无法显示。</span>
            <Button size="sm" variant="outline" onClick={() => detail.refetch()} disabled={detail.loading}>
              刷新
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">当前状态</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <StateStat label="安装状态" view={inst} hint="网关记录的安装结果" />
          <StateStat label="运行状态" view={run} hint="扩展当前是否在运行" />
          <StateStat label="健康状态" view={health} hint="扩展最近一次自检结果" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">模型服务</CardTitle>
          <CardDescription>
            {ext.providers.length === 0
              ? '该扩展没有提供模型服务。'
              : '该扩展提供以下模型服务。点击名称可以查看模型。'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {ext.providers.map((p) => (
              <a
                key={p}
                href={`#/providers/${encodeURIComponent(p)}`}
                title={`查看 ${p} 的模型`}
                className="transition-colors"
              >
                <Badge variant="secondary" className="font-mono hover:bg-primary/15">
                  {p}
                </Badge>
              </a>
            ))}
          </div>
          {ext.providers.length > 0 ? (
            <>
              <Separator />
              <p className="text-xs text-muted-foreground">{registrationHint(ext)}</p>
            </>
          ) : null}
          {!ext.providersRegistered && canReload ? (
            <div>
              <Button size="sm" variant="outline" onClick={() => void reload()} disabled={reloading}>
                {reloading ? <Spinner data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}
                重载服务
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {storedError ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">最近一次错误</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm font-medium text-destructive">{storedError.summary}</p>
            <p className="text-sm text-muted-foreground">{storedError.hint}</p>
            <TechnicalDetails detail={storedError.detail} />
          </CardContent>
        </Card>
      ) : null}

      {ext.providers.map((p) => (
        <ProviderActionsCard key={p} extensionId={ext.extensionId} providerId={p} />
      ))}

      <details className="rounded-lg border border-border/60 px-3 py-2 text-sm">
        <summary className="cursor-pointer select-none text-muted-foreground">
          技术信息（排查问题时使用）
        </summary>
        <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <InfoRow label="扩展 ID" value={ext.extensionId} mono />
          <InfoRow
            label="镜像"
            value={`${ext.image.repo ?? '未知'}:${ext.image.tag ?? '未知'}`}
            mono
          />
          <InfoRow label="镜像摘要" value={ext.image.digest ?? '未知'} mono />
          <InfoRow label="安装状态原始值" value={ext.installState} mono />
        </dl>
      </details>

      <LifecycleDialog
        request={confirm}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={runLifecycle}
      />
    </div>
  )
}

function registrationHint(ext: ExtensionRecord): string {
  if (ext.providers.length === 0) return '该扩展没有提供模型服务。'
  if (ext.providersRegistered) return '所有模型服务均已接入网关，可以正常使用。'
  if (ext.runtimeState === 'stopped') return '扩展当前未运行，启动后模型服务会自动接入。'
  if (ext.installState === 'failed') {
    return '扩展未能成功启动，模型服务暂不可用。可以先尝试重启，或查看下方错误信息。'
  }
  return '有模型服务尚未接入网关。如果刚刚安装或升级了扩展，请点击「重载服务」。'
}

function DetailLoading({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <BackButton onBack={onBack} />
      </div>
      <LoadingCard text="正在加载扩展信息…" />
    </div>
  )
}

function StateStat({ label, view, hint }: { label: string; view: StatusView; hint: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`w-fit rounded-full border px-2 py-0.5 text-sm font-medium ${SEVERITY_CLASS[view.severity]}`}
      >
        {view.label}
      </span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  )
}

/**
 * Manifest-driven actions for one provider: the form is generated from the
 * declared inputSchema (string/number/boolean properties), the result rendered
 * as returned data. No provider-specific UI branches.
 */
function ProviderActionsCard({
  extensionId,
  providerId,
}: {
  extensionId: string
  providerId: string
}) {
  const actions = useQuery(() => extensionsApi.actions(extensionId, providerId), [
    extensionId,
    providerId,
  ])
  const [active, setActive] = React.useState<ManifestAction | null>(null)

  if (actions.loading && !actions.data) {
    return <LoadingCard text={`正在加载「${providerId}」的可用操作…`} />
  }
  if (actions.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">可用操作 · <span className="font-mono">{providerId}</span></CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorNotice
            title="无法加载可用操作"
            explanation={describeExtensionError(actions.error, 'load')}
            onRetry={() => actions.refetch()}
          />
        </CardContent>
      </Card>
    )
  }
  const declared = actions.data?.actions ?? []
  if (declared.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            可用操作 · <span className="font-mono">{providerId}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          该服务没有可在控制台执行的操作。
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          可用操作 · <span className="font-mono">{providerId}</span>
        </CardTitle>
        <CardDescription>这些操作由扩展提供。标有 * 的操作会修改数据，请确认后再执行。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {declared.map((a) => (
          <Button key={a.id} size="sm" variant="outline" onClick={() => setActive(a)}>
            {a.title ?? a.id}
            {a.sideEffects === 'mutating' ? <span className="ml-1.5 text-xs text-warning">*</span> : null}
          </Button>
        ))}
      </CardContent>
      {active ? (
        <ActionDialog
          key={active.id}
          action={active}
          extensionId={extensionId}
          providerId={providerId}
          onClose={() => setActive(null)}
        />
      ) : null}
    </Card>
  )
}

/** Primitive JSON-schema form: covers the types manifest actions use. */
function ActionDialog({
  action,
  extensionId,
  providerId,
  onClose,
}: {
  action: ManifestAction
  extensionId: string
  providerId: string
  onClose: () => void
}) {
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [accountId, setAccountId] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [validation, setValidation] = React.useState<string | null>(null)
  const [error, setError] = React.useState<unknown>(null)
  const [result, setResult] = React.useState<{ value: unknown } | null>(null)

  const props = objectProperties(action.inputSchema)
  const title = action.title ?? action.id
  const mutating = action.sideEffects === 'mutating'
  const oneShot = action.sideEffects === 'one-shot'
  const explanation = error ? describeExtensionError(error) : null

  const close = () => {
    if (busy) return
    onClose()
  }

  const submit = async () => {
    if (busy) return
    const missing = props
      .filter(([key]) => isRequired(action.inputSchema, key) && (values[key] ?? '').trim() === '')
      .map(([key, prop]) => propertyLabel(key, prop))
    if (missing.length > 0) {
      setValidation(`请填写：${missing.join('、')}`)
      return
    }
    setValidation(null)
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const payload: Record<string, unknown> = {}
      const propMap = new Map(props)
      for (const [key, raw] of Object.entries(values)) {
        if (raw === '') continue
        const type = propMap.get(key)?.type ?? 'string'
        payload[key] =
          type === 'number' || type === 'integer'
            ? Number(raw)
            : type === 'boolean'
              ? raw === 'true'
              : raw
      }
      const res = await extensionsApi.invokeAction(extensionId, providerId, action.id, {
        accountId: accountId || undefined,
        payload,
      })
      setResult({ value: res.result })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="max-h-[85svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {action.description ?? `执行「${title}」，结果会显示在这里。`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {mutating ? (
            <p className="rounded-md border border-warning/25 bg-warning/12 p-2 text-xs text-warning">
              此操作会修改扩展数据，请确认后执行。
            </p>
          ) : null}
          {oneShot ? (
            <p className="rounded-md border border-warning/25 bg-warning/12 p-2 text-xs text-warning">
              此操作只能执行一次，提交前请确认内容。
            </p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="action-account">账号（可选）</Label>
            <Input
              id="action-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="留空时使用扩展的默认账号"
              disabled={busy}
            />
          </div>
          {props.map(([key, prop]) => (
            <div key={key} className="flex flex-col gap-1.5">
              <Label htmlFor={`action-${key}`}>
                {propertyLabel(key, prop)}
                {isRequired(action.inputSchema, key) ? ' *' : ''}
              </Label>
              {prop.type === 'boolean' ? (
                <select
                  id={`action-${key}`}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  value={values[key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                  disabled={busy}
                >
                  <option value="">默认</option>
                  <option value="true">是</option>
                  <option value="false">否</option>
                </select>
              ) : (
                <Input
                  id={`action-${key}`}
                  type={prop.type === 'number' || prop.type === 'integer' ? 'number' : 'text'}
                  value={values[key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                  placeholder={prop.type === 'string' ? '可选' : undefined}
                  disabled={busy}
                />
              )}
            </div>
          ))}
          {validation ? (
            <p className="text-sm text-destructive" role="alert">
              {validation}
            </p>
          ) : null}
          {explanation ? (
            <div
              role="alert"
              className="flex flex-col gap-1 rounded-md border border-destructive/25 bg-destructive/12 p-2 text-sm text-destructive"
            >
              <span className="font-medium">{explanation.summary}</span>
              <span className="text-xs">{explanation.hint}</span>
              <TechnicalDetails detail={explanation.detail} />
            </div>
          ) : null}
          {result ? (
            <div className="rounded-md border border-border/60 bg-muted/40 p-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">执行结果</p>
              {result.value === null || result.value === undefined ? (
                <p className="text-sm">操作已完成，没有返回数据。</p>
              ) : (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {typeof result.value === 'string'
                    ? result.value
                    : JSON.stringify(result.value, null, 2)}
                </pre>
              )}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            关闭
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            执行
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface SchemaProperty {
  type?: string
  description?: string
}

function objectProperties(
  schema: Record<string, unknown> | undefined,
): Array<[string, SchemaProperty]> {
  if (!schema || typeof schema !== 'object') return []
  const props = (schema as { properties?: Record<string, SchemaProperty> }).properties
  if (!props) return []
  return Object.entries(props).filter(([, value]) => value !== null && typeof value === 'object')
}

function propertyLabel(key: string, prop: SchemaProperty): string {
  return typeof prop.description === 'string' && prop.description.trim() !== ''
    ? prop.description
    : key
}

function isRequired(schema: Record<string, unknown> | undefined, key: string): boolean {
  const req = (schema as { required?: string[] } | undefined)?.required
  return Array.isArray(req) && req.includes(key)
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const LIFECYCLE_TEXT: Record<
  LifecycleVerb,
  { title: string; description: string; confirm: string; destructive?: boolean }
> = {
  start: {
    title: '启动扩展',
    description: '启动后，该扩展提供的模型服务会恢复可用。',
    confirm: '启动',
  },
  restart: {
    title: '重启扩展',
    description: '重启期间，该扩展提供的模型服务可能短暂不可用。',
    confirm: '重启',
  },
  stop: {
    title: '停止扩展',
    description: '停止后，该扩展提供的模型服务将暂时不可用。',
    confirm: '停止',
  },
  remove: {
    title: '移除扩展',
    description:
      '将停止并移除该扩展及其运行记录，但会保留扩展数据（例如登录凭据），重新安装后可以继续使用。',
    confirm: '移除',
    destructive: true,
  },
}

function lifecycleNotice(request: LifecycleRequest): string {
  if (request.verb === 'remove') return `已移除扩展「${request.id}」，扩展数据已保留。`
  if (request.verb === 'stop') return `已停止扩展「${request.id}」。`
  if (request.verb === 'start') return `已启动扩展「${request.id}」。`
  return `已重启扩展「${request.id}」。`
}

function LifecycleDialog({
  request,
  busy,
  onCancel,
  onConfirm,
}: {
  request: LifecycleRequest | null
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const text = request ? LIFECYCLE_TEXT[request.verb] : null
  return (
    <Dialog open={request !== null} onOpenChange={(open) => (open || busy ? undefined : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{text?.title}</DialogTitle>
          <DialogDescription>{text?.description}</DialogDescription>
        </DialogHeader>
        {request ? (
          <p className="text-sm text-muted-foreground">
            扩展：<span className="font-mono">{request.id}</span>
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button
            variant={text?.destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {text?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeftIcon data-icon="inline-start" /> 返回扩展列表
    </Button>
  )
}

function LoadingCard({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Spinner /> {text}
      </CardContent>
    </Card>
  )
}

function SuccessNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-success/25 bg-success/12 p-3 text-sm text-success"
    >
      <span className="min-w-0 break-words">{text}</span>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onDismiss}>
        关闭
      </Button>
    </div>
  )
}

function ErrorNotice({
  title,
  explanation,
  onRetry,
  onBack,
  onDismiss,
}: {
  title: string
  explanation: ReturnType<typeof describeExtensionError>
  onRetry?: () => void
  onBack?: () => void
  onDismiss?: () => void
}) {
  return (
    <Alert variant="destructive" className="p-3">
      <TriangleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span className="font-medium">{explanation.summary}</span>
        <span>{explanation.hint}</span>
        <div className="flex flex-wrap gap-2">
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              重试
            </Button>
          ) : null}
          {onBack ? (
            <Button size="sm" variant="ghost" onClick={onBack}>
              返回扩展列表
            </Button>
          ) : null}
          {onDismiss ? (
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              关闭
            </Button>
          ) : null}
        </div>
        <TechnicalDetails detail={explanation.detail} />
      </AlertDescription>
    </Alert>
  )
}

function TechnicalDetails({ detail }: { detail: string | null }) {
  if (!detail) return null
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground">技术详情</summary>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-xs">
        {detail}
      </pre>
    </details>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'break-all font-mono' : 'break-words'}>{value}</dd>
    </div>
  )
}

function formatInstalledAt(ts: number | null): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '时间未知'
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
