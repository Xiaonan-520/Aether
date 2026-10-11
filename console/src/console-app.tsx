/**
 * Console shell: top bar, admin-token gate, routing. Data itself lives in
 * pages — this file only decides whether the console can talk to the core.
 */
import * as React from 'react'
import { MotionConfig } from 'motion/react'
import { getStoredToken, storeToken, ApiError } from '@/lib/api'
import { useRoute } from '@/lib/router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { MoonIcon, SunIcon } from 'lucide-react'
import { HomePage } from './pages/home-page'
import { ProviderPage } from './pages/provider-page'
import { ExtensionsPage, ExtensionDetailPage } from './pages/extensions-page'
import { KeysPage } from './pages/keys-page'

export function ConsoleApp({
  theme,
  onToggleTheme,
}: {
  theme: 'dark' | 'light'
  onToggleTheme: () => void
}) {
  const [token, setToken] = React.useState(getStoredToken)
  const [route, navigate] = useRoute()

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-svh flex-col">
        <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
            <a
              href="#/"
              className="flex min-w-0 items-center gap-2.5 text-sm font-semibold tracking-tight"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary">
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" />
                  <path d="M12 12 3 7m9 5 9-5m-9 5v10" />
                </svg>
              </span>
              <span className="truncate">Gateway Console</span>
            </a>
            <nav className="ml-2 hidden items-center gap-1 text-sm sm:flex" aria-label="Main">
              <a
                href="#/"
                aria-current={route.name === 'home' || route.name === 'provider' ? 'page' : undefined}
                className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
              >
                Providers
              </a>
              <a
                href="#/extensions"
                aria-current={route.name === 'extensions' || route.name === 'extension' ? 'page' : undefined}
                className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
              >
                Extensions
              </a>
              <a
                href="#/keys"
                aria-current={route.name === 'keys' ? 'page' : undefined}
                className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
              >
                API Keys
              </a>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {token ? <span className="hidden text-xs text-muted-foreground md:inline">admin session active</span> : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                onClick={onToggleTheme}
              >
                {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
              </Button>
              {token ? (
                <Button variant="outline" size="sm" onClick={() => { storeToken(''); setToken('') }}>
                  Sign out
                </Button>
              ) : null}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {token ? (
            route.name === 'home' ? (
              <HomePage />
            ) : route.name === 'provider' ? (
              <ProviderPage id={route.id} onBack={() => navigate('/')} />
            ) : route.name === 'extensions' ? (
              <ExtensionsPage onOpen={(id) => navigate(`#/extensions/${encodeURIComponent(id)}`)} />
            ) : route.name === 'extension' ? (
              <ExtensionDetailPage id={route.id} onBack={() => navigate('#/extensions')} />
            ) : route.name === 'keys' ? (
              <KeysPage />
            ) : null
          ) : (
            <TokenGate onDone={(t) => { storeToken(t); setToken(t) }} />
          )}
        </main>

        <footer className="border-t border-border/70 py-4">
          <div className="mx-auto w-full max-w-7xl px-4 text-xs text-muted-foreground sm:px-6">
            Gateway Core management console · data via <code className="font-mono">/api/*</code> · admin token stays in this browser (sessionStorage)
          </div>
        </footer>
      </div>
    </MotionConfig>
  )
}

function TokenGate({ onDone }: { onDone: (token: string) => void }) {
  const [value, setValue] = React.useState('')
  const [checking, setChecking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!value.trim() || checking) return
    setChecking(true)
    setError(null)
    // verify the token against a cheap admin endpoint before storing it
    try {
      await fetch('/api/console/overview', {
        headers: { Authorization: `Bearer ${value.trim()}` },
      }).then(async (res) => {
        if (res.status === 401) throw new ApiError(401, 'Token rejected by the gateway (401)')
        if (!res.ok) throw new ApiError(res.status, `Gateway returned ${res.status}`)
        return res.json()
      })
      onDone(value.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 pt-10 sm:pt-20">
      <Card>
        <CardHeader>
          <CardTitle>Admin sign-in</CardTitle>
          <CardDescription>
            Paste the gateway admin token (<code className="font-mono">GATEWAY_ADMIN_TOKEN</code>).
            It is verified against the core and kept in this browser tab only — never sent anywhere else.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={submit}>
            <Input
              type="password"
              placeholder="Gateway admin token"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={error ? true : undefined}
              autoFocus
            />
            {error ? (
              <p className="text-sm text-destructive" role="alert">{error}</p>
            ) : null}
            <Button type="submit" disabled={checking || !value.trim()}>
              {checking ? <Spinner data-icon="inline-start" /> : null}
              Unlock console
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
