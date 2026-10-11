/**
 * Status primitives: one visual language for every state the console shows.
 * Colors come from the severity map in lib/status — components never pick
 * raw hues per page.
 */
import type { Severity } from '@/lib/status'
import { SEVERITY_CLASS, severityDot } from '@/lib/status'
import { cn } from 'cn'

export function StatusBadge({
  label,
  severity,
  className,
}: {
  label: string
  severity: Severity
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center gap-1.5 rounded-4xl border px-2 text-xs font-medium whitespace-nowrap',
        SEVERITY_CLASS[severity],
        className,
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', severityDot(severity))} />
      {label}
    </span>
  )
}

export function StatusDot({ severity }: { severity: Severity }) {
  return (
    <span className="relative inline-flex size-2.5 items-center justify-center">
      <span className={cn('size-2 rounded-full', severityDot(severity))} />
      {severity === 'ok' && (
        <span className="absolute size-2 animate-ping rounded-full bg-success/60 motion-reduce:animate-none" />
      )}
    </span>
  )
}

export function DataPoint({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="nums truncate text-sm font-medium">{children}</span>
    </div>
  )
}
