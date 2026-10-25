/**
 * Catches render-time exceptions so a UI bug can no longer produce a fully
 * blank console page. The fallback states what happened, offers recovery and
 * keeps the real error available (collapsed) for troubleshooting.
 */
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { TriangleAlertIcon } from 'lucide-react'

interface Props {
  children: React.ReactNode
  /** Changing this (e.g. route id) clears a previous failure. */
  resetKey?: string
}

interface State {
  error: Error | null
}

export class RouteErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error): void {
    // Keep the detail in the browser console for developers even though it is
    // collapsed in the UI.
    console.error('console render error', error)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <Alert variant="destructive" className="p-4">
        <TriangleAlertIcon />
        <AlertTitle>页面暂时无法显示</AlertTitle>
        <AlertDescription className="flex flex-col gap-3">
          <div>页面在显示时遇到了问题，这不是您刚才的操作造成的。</div>
          <div>可以先重试；如果反复出现，请把下方技术详情提供给管理员。</div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => this.setState({ error: null })}>
              重试
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
              重新加载页面
            </Button>
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer select-none text-muted-foreground">技术详情</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-xs">
              {error.message}
            </pre>
          </details>
        </AlertDescription>
      </Alert>
    )
  }
}
