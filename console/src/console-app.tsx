/**
 * Console shell: top bar, auth gate, routing. Data itself lives in pages —
 * this file only decides whether the console can talk to the core.
 */
import * as React from 'react'
import { MotionConfig } from 'motion/react'
import { useRoute } from '@/lib/router'
import { AuthGate, useAuth, MIN_PASSWORD_LENGTH } from '@/components/auth-gate'
import { changePassword, storeToken, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  const [passwordOpen, setPasswordOpen] = React.useState(false)

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
              {/* Only an account-backed session has a password to change. */}
              {auth?.user ? (
                <Button variant="ghost" size="sm" onClick={() => setPasswordOpen(true)}>
                  Password
                </Button>
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

      <PasswordDialog
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        onChanged={(nextToken) => {
          // The server revoked the old session and issued a new one; keep this
          // tab signed in with it.
          storeToken(nextToken)
          setPasswordOpen(false)
        }}
      />
    </MotionConfig>
  )
}

/**
 * Change the signed-in admin's password.
 *
 * Requires the current password even though a session already exists: a
 * stolen session must not be enough to lock the real owner out. The server
 * revokes every session afterwards and returns a fresh one for this tab.
 */
function PasswordDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean
  onClose: () => void
  onChanged: (newToken: string) => void
}) {
  const [current, setCurrent] = React.useState('')
  const [next, setNext] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH
  const mismatch = confirm.length > 0 && next !== confirm
  const canSubmit =
    current.length > 0 && next.length >= MIN_PASSWORD_LENGTH && next === confirm && !busy

  const reset = () => {
    setCurrent('')
    setNext('')
    setConfirm('')
    setError(null)
    setBusy(false)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const session = await changePassword(current, next)
      reset()
      onChanged(session.token)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Current password is incorrect.')
      } else {
        setError(err instanceof Error ? err.message : 'Could not change the password')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          reset()
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            Every other signed-in session is signed out. This browser stays signed in.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pw-current">Current password</Label>
            <Input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pw-new">New password</Label>
            <Input
              id="pw-new"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              aria-invalid={tooShort || undefined}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pw-confirm">Confirm new password</Label>
            <Input
              id="pw-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch || undefined}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            At least {MIN_PASSWORD_LENGTH} characters, stored as a salted scrypt digest.
          </p>
          {tooShort ? (
            <p className="text-sm text-destructive" role="alert">
              Password must be at least {MIN_PASSWORD_LENGTH} characters.
            </p>
          ) : null}
          {mismatch ? (
            <p className="text-sm text-destructive" role="alert">
              Passwords do not match.
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { reset(); onClose() }} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              Update password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
