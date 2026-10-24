/**
 * Authentication gate for the console.
 *
 * Three states, decided from /api/auth/status:
 *   - not initialized  → first-run admin registration
 *   - initialized      → email + password sign-in
 *   - session valid    → children (the normal console)
 *
 * The static GATEWAY_ADMIN_TOKEN is still accepted: the sign-in form has a
 * secondary "use a static admin token" mode for operators who have not created
 * an account yet or run automation.
 */
import * as React from 'react'
import {
  ApiError,
  fetchAuthStatus,
  fetchMe,
  getStoredToken,
  loginAdmin,
  logoutAdmin,
  onUnauthorized,
  registerAdmin,
  storeToken,
  type AuthUser,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'

export const MIN_PASSWORD_LENGTH = 10

type Phase =
  | { name: 'loading' }
  | { name: 'register' }
  | { name: 'login' }
  | { name: 'ready'; user: AuthUser | null; staticToken: boolean }

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = React.useState<Phase>({ name: 'loading' })
  /** One-shot message shown on the sign-in screen (e.g. registration closed). */
  const [notice, setNotice] = React.useState<string | null>(null)

  // Resolve the initial phase once on mount. The awaits put every setState
  // after an async boundary, so no render is scheduled synchronously from the
  // effect body (react-hooks/set-state-in-effect).
  React.useEffect(() => {
    let cancelled = false
    const settle = (next: Phase) => {
      if (!cancelled) setPhase(next)
    }

    void (async () => {
      const stored = getStoredToken()
      if (stored) {
        // A stored credential may be a session token or the static env token.
        // /auth/me distinguishes them and also proves the credential is live.
        try {
          const me = await fetchMe()
          if (me.user || me.staticToken) {
            settle({ name: 'ready', user: me.user, staticToken: me.staticToken })
            return
          }
        } catch (err) {
          // 401 means expired/revoked: drop it and fall through to sign-in.
          if (err instanceof ApiError && err.status === 401) storeToken('')
          // A network error leaves the stored token alone but still shows the
          // sign-in screen; retrying is the user's call.
        }
      }
      try {
        const status = await fetchAuthStatus()
        settle(status.initialized ? { name: 'login' } : { name: 'register' })
      } catch {
        // Gateway unreachable: show sign-in so the error is visible on submit.
        settle({ name: 'login' })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  // Any 401 from a page means the session died while the console was open.
  React.useEffect(() => {
    return onUnauthorized(() => {
      storeToken('')
      setPhase({ name: 'login' })
    })
  }, [])

  const onAuthenticated = React.useCallback(
    async (token: string) => {
      storeToken(token)
      try {
        const me = await fetchMe()
        setPhase({ name: 'ready', user: me.user, staticToken: me.staticToken })
      } catch {
        setPhase({ name: 'ready', user: null, staticToken: true })
      }
    },
    [],
  )

  const onSignOut = React.useCallback(async () => {
    await logoutAdmin()
    storeToken('')
    setPhase({ name: 'login' })
  }, [])

  if (phase.name === 'loading') {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    )
  }

  if (phase.name === 'register') {
    return (
      <RegisterForm
        onAuthenticated={onAuthenticated}
        onAlreadyExists={() => {
          // Registration closed while this form was open. Carry the reason
          // into the sign-in screen — the register form is about to unmount,
          // so its local error state would be lost.
          setNotice('An administrator already exists. Sign in instead.')
          setPhase({ name: 'login' })
        }}
      />
    )
  }

  if (phase.name === 'login') {
    return <LoginForm notice={notice} onAuthenticated={onAuthenticated} />
  }

  return (
    <ConsoleContent user={phase.user} staticToken={phase.staticToken} onSignOut={onSignOut}>
      {children}
    </ConsoleContent>
  )
}

/** Provides the signed-in identity and a working sign-out to the shell. */
const AuthContext = React.createContext<{ user: AuthUser | null; staticToken: boolean; signOut: () => void } | null>(null)

export function useAuth() {
  return React.useContext(AuthContext)
}

function ConsoleContent({
  user,
  staticToken,
  onSignOut,
  children,
}: {
  user: AuthUser | null
  staticToken: boolean
  onSignOut: () => void
  children: React.ReactNode
}) {
  const value = React.useMemo(
    () => ({ user, staticToken, signOut: onSignOut }),
    [user, staticToken, onSignOut],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function Field({
  id,
  label,
  ...props
}: React.ComponentProps<typeof Input> & { id: string; label: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  )
}

function FormError({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-destructive" role="alert">
      {children}
    </p>
  )
}

function AuthShell({
  title,
  description,
  children,
}: {
  title: string
  description: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 pt-10 sm:pt-20">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  )
}

function RegisterForm({
  onAuthenticated,
  onAlreadyExists,
}: {
  onAuthenticated: (token: string) => Promise<void>
  onAlreadyExists: () => void
}) {
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH
  const mismatch = confirm.length > 0 && password !== confirm
  const canSubmit =
    email.trim().length > 0 && password.length >= MIN_PASSWORD_LENGTH && password === confirm && !busy

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const session = await registerAdmin(email.trim(), password)
      await onAuthenticated(session.token)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Someone else registered first — registration is now closed for good.
        setError('An administrator already exists. Sign in instead.')
        onAlreadyExists()
        return
      }
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="Create the administrator account"
      description={
        <>
          This gateway has no administrator yet. Registration is open exactly once — after this
          account is created, the public sign-up entry closes permanently.
        </>
      }
    >
      <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
        <Field
          id="reg-email"
          label="Email"
          type="email"
          autoComplete="username"
          placeholder="operator@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <Field
          id="reg-password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={tooShort || undefined}
        />
        <Field
          id="reg-confirm"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={mismatch || undefined}
        />
        <p className="text-xs text-muted-foreground">
          At least {MIN_PASSWORD_LENGTH} characters. Stored as a salted scrypt digest — never in
          plaintext, never reversibly.
        </p>
        {tooShort ? <FormError>Password must be at least {MIN_PASSWORD_LENGTH} characters.</FormError> : null}
        {mismatch ? <FormError>Passwords do not match.</FormError> : null}
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" disabled={!canSubmit}>
          {busy ? <Spinner data-icon="inline-start" /> : null}
          Create administrator
        </Button>
      </form>
    </AuthShell>
  )
}

function LoginForm({
  onAuthenticated,
  notice,
}: {
  onAuthenticated: (token: string) => Promise<void>
  notice?: string | null
}) {
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [showStatic, setShowStatic] = React.useState(false)
  const [staticToken, setStaticToken] = React.useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (showStatic) {
        const value = staticToken.trim()
        if (!value) throw new ApiError(400, 'Enter the admin token')
        // Verify before storing so a typo does not leave a dead credential.
        storeToken(value)
        try {
          await fetchMe()
        } catch (err) {
          storeToken('')
          throw err
        }
        await onAuthenticated(value)
        return
      }
      const session = await loginAdmin(email.trim(), password)
      await onAuthenticated(session.token)
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('Too many failed attempts. Wait a few minutes and try again.')
      } else if (err instanceof ApiError && err.status === 401) {
        setError('Email or password is incorrect.')
      } else {
        setError(err instanceof Error ? err.message : 'Sign-in failed')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="Sign in"
      description={
        showStatic
          ? 'Use the static gateway admin token (GATEWAY_ADMIN_TOKEN). Intended for automation and bootstrap recovery.'
          : 'Sign in with the administrator email and password.'
      }
    >
      <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
        {showStatic ? (
          <Field
            id="login-static"
            label="Admin token"
            type="password"
            autoComplete="off"
            placeholder="Paste GATEWAY_ADMIN_TOKEN"
            value={staticToken}
            onChange={(e) => setStaticToken(e.target.value)}
            autoFocus
          />
        ) : (
          <>
            <Field
              id="login-email"
              label="Email"
              type="email"
              autoComplete="username"
              placeholder="operator@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
            <Field
              id="login-password"
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        )}
        {notice && !error ? (
          <p className="text-sm text-muted-foreground" role="status">
            {notice}
          </p>
        ) : null}
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" disabled={busy || (showStatic ? !staticToken.trim() : !email.trim() || !password)}>
          {busy ? <Spinner data-icon="inline-start" /> : null}
          Sign in
        </Button>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => {
            setShowStatic((v) => !v)
            setError(null)
          }}
        >
          {showStatic ? 'Use email and password' : 'Use a static admin token'}
        </Button>
      </form>
    </AuthShell>
  )
}
