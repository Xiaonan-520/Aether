/**
 * Console shell: top bar, auth gate, routing. Data itself lives in pages —
 * this file only decides whether the console can talk to the core.
 */
import { MotionConfig } from 'motion/react'
import { useRoute } from '@/lib/router'
import { AuthGate, useAuth } from '@/components/auth-gate'
import { Button } from '@/components/ui/button'
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
  return (
    <MotionConfig reducedMotion="user">
      <AuthGate>
        <ConsoleShell theme={theme} onToggleTheme={onToggleTheme} />
      </AuthGate>
    </MotionConfig>
  )
}

function ConsoleShell({
  theme,
  onToggleTheme,
}: {
  theme: 'dark' | 'light'
  onToggleTheme: () => void
}) {
  const [route, navigate] = useRoute()
  const auth = useAuth()

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
              <span className="truncate">Aether Console</span>
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
              {auth?.user ? (
                <span className="hidden text-xs text-muted-foreground md:inline" title={auth.user.email}>
                  {auth.user.email}
                </span>
              ) : auth?.staticToken ? (
                <span className="hidden text-xs text-muted-foreground md:inline">static admin token</span>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                onClick={onToggleTheme}
              >
                {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void auth?.signOut()}>
                Sign out
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {route.name === 'home' ? (
            <HomePage />
          ) : route.name === 'provider' ? (
            <ProviderPage id={route.id} onBack={() => navigate('/')} />
          ) : route.name === 'extensions' ? (
            <ExtensionsPage onOpen={(id) => navigate(`#/extensions/${encodeURIComponent(id)}`)} />
          ) : route.name === 'extension' ? (
            <ExtensionDetailPage id={route.id} onBack={() => navigate('#/extensions')} />
          ) : route.name === 'keys' ? (
            <KeysPage />
          ) : null}
        </main>

        <footer className="border-t border-border/70 py-4">
          <div className="mx-auto w-full max-w-7xl px-4 text-xs text-muted-foreground sm:px-6">
            Aether Core management console · data via <code className="font-mono">/api/*</code> · session
            credential stays in this browser tab (sessionStorage)
          </div>
        </footer>
      </div>
    </MotionConfig>
  )
}
