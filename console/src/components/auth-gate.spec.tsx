/**
 * AuthGate behaviour: which screen is shown for each backend state, and how
 * the three credential paths (register, login, static token) are handled.
 *
 * The gate is driven entirely by /api/auth/status and /api/auth/me, so these
 * tests stub fetch rather than reaching a real gateway.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthGate } from './auth-gate'
import { storeToken } from '@/lib/api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

type Route = (input: string, init?: RequestInit) => Response | Promise<Response>

/** Minimal fetch stub: routes by URL, records calls. */
function stubFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) return Promise.resolve(handler(url, init))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  })
  vi.stubGlobal('fetch', mock)
  return calls
}

afterEach(() => {
  // vitest runs with globals:false here, so @testing-library's automatic
  // cleanup is not registered — unmount explicitly or the next render stacks
  // a second copy of the form into the same document.
  cleanup()
  vi.unstubAllGlobals()
  storeToken('')
  sessionStorage.clear()
})

describe('AuthGate — first run', () => {
  it('shows the registration form when the gateway has no admin', async () => {
    stubFetch({
      '/api/auth/status': () => jsonResponse({ initialized: false }),
    })
    render(<AuthGate>console body</AuthGate>)
    expect(await screen.findByText(/Create the administrator account/i)).toBeTruthy()
    expect(screen.queryByText('console body')).toBeNull()
  })

  it('disables submit until email, password and confirmation are valid', async () => {
    stubFetch({ '/api/auth/status': () => jsonResponse({ initialized: false }) })
    render(<AuthGate>console body</AuthGate>)
    await screen.findByText(/Create the administrator account/i)

    const submit = screen.getByRole('button', { name: /Create administrator/i }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'ops@aether.test')
    expect(submit.disabled).toBe(true)

    await user.type(screen.getByLabelText('Password'), 'short')
    expect(screen.getByRole('alert').textContent).toMatch(/at least 10 characters/i)
    expect(submit.disabled).toBe(true)

    await user.clear(screen.getByLabelText('Password'))
    await user.type(screen.getByLabelText('Password'), 'long-enough-password')
    expect(submit.disabled).toBe(true) // confirmation still empty

    await user.type(screen.getByLabelText('Confirm password'), 'different-password')
    expect(screen.getByText(/Passwords do not match/i)).toBeTruthy()
    expect(submit.disabled).toBe(true)

    await user.clear(screen.getByLabelText('Confirm password'))
    await user.type(screen.getByLabelText('Confirm password'), 'long-enough-password')
    expect(submit.disabled).toBe(false)
  })

  it('registers and enters the console', async () => {
    const calls = stubFetch({
      '/api/auth/status': () => jsonResponse({ initialized: false }),
      '/api/auth/register': () =>
        jsonResponse({
          token: 'adm-session-token',
          expiresAt: Date.now() + 1000,
          user: { id: 'u1', email: 'ops@aether.test', createdAt: 1 },
        }, 201),
      '/api/auth/me': () =>
        jsonResponse({
          user: { id: 'u1', email: 'ops@aether.test', createdAt: 1 },
          staticToken: false,
          expiresAt: Date.now() + 1000,
        }),
    })
    render(<AuthGate>console body</AuthGate>)
    await screen.findByText(/Create the administrator account/i)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'ops@aether.test')
    await user.type(screen.getByLabelText('Password'), 'long-enough-password')
    await user.type(screen.getByLabelText('Confirm password'), 'long-enough-password')
    await user.click(screen.getByRole('button', { name: /Create administrator/i }))

    expect(await screen.findByText('console body')).toBeTruthy()
    const registerCall = calls.find((c) => c.url.includes('/api/auth/register'))
    expect(registerCall).toBeDefined()
    const body = JSON.parse(String(registerCall!.init?.body)) as Record<string, unknown>
    expect(body.email).toBe('ops@aether.test')
    expect(body.password).toBe('long-enough-password')
  })

  it('falls back to sign-in when registration was already taken', async () => {
    stubFetch({
      '/api/auth/status': () => jsonResponse({ initialized: false }),
      '/api/auth/register': () =>
        jsonResponse({ error: 'registration_closed', message: 'an administrator account already exists' }, 409),
    })
    render(<AuthGate>console body</AuthGate>)
    await screen.findByText(/Create the administrator account/i)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'ops@aether.test')
    await user.type(screen.getByLabelText('Password'), 'long-enough-password')
    await user.type(screen.getByLabelText('Confirm password'), 'long-enough-password')
    await user.click(screen.getByRole('button', { name: /Create administrator/i }))

    expect(await screen.findByLabelText('Email')).toBeTruthy()
    expect(await screen.findByText(/already exists/i)).toBeTruthy()
  })
})

describe('AuthGate — sign-in', () => {
  it('shows the login form when an admin already exists', async () => {
    stubFetch({ '/api/auth/status': () => jsonResponse({ initialized: true }) })
    render(<AuthGate>console body</AuthGate>)
    expect(await screen.findByRole('button', { name: /^Sign in$/i })).toBeTruthy()
    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
  })

  it('shows a generic error for bad credentials', async () => {
    stubFetch({
      '/api/auth/status': () => jsonResponse({ initialized: true }),
      '/api/auth/login': () => jsonResponse({ error: 'invalid_credentials', message: 'email or password is incorrect' }, 401),
    })
    render(<AuthGate>console body</AuthGate>)
    await screen.findByLabelText('Email')

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'ops@aether.test')
    await user.type(screen.getByLabelText('Password'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: /^Sign in$/i }))

    expect(await screen.findByText(/Email or password is incorrect/i)).toBeTruthy()
    expect(screen.queryByText('console body')).toBeNull()
  })

  it('explains throttling explicitly', async () => {
    stubFetch({
      '/api/auth/status': () => jsonResponse({ initialized: true }),
      '/api/auth/login': () => jsonResponse({ error: 'too_many_attempts' }, 429),
    })
    render(<AuthGate>console body</AuthGate>)
    await screen.findByLabelText('Email')

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'ops@aether.test')
    await user.type(screen.getByLabelText('Password'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: /^Sign in$/i }))

    expect(await screen.findByText(/Too many failed attempts/i)).toBeTruthy()
  })

  it('signs in and enters the console', async () => {
    stubFetch({
      '/api/auth/status': () => jsonResponse({ initialized: true }),
      '/api/auth/login': () =>
        jsonResponse({
          token: 'adm-session-token',
          expiresAt: Date.now() + 1000,
          user: { id: 'u1', email: 'ops@aether.test', createdAt: 1 },
        }),
      '/api/auth/me': () =>
        jsonResponse({
          user: { id: 'u1', email: 'ops@aether.test', createdAt: 1 },
          staticToken: false,
          expiresAt: Date.now() + 1000,
        }),
    })
    render(<AuthGate>console body</AuthGate>)
    await screen.findByLabelText('Email')

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'ops@aether.test')
    await user.type(screen.getByLabelText('Password'), 'long-enough-password')
    await user.click(screen.getByRole('button', { name: /^Sign in$/i }))

    expect(await screen.findByText('console body')).toBeTruthy()
  })

  it('accepts a static admin token through the alternate mode', async () => {
    stubFetch({
      '/api/auth/status': () => jsonResponse({ initialized: true }),
      '/api/auth/me': () => jsonResponse({ user: null, staticToken: true, expiresAt: null }),
    })
    render(<AuthGate>console body</AuthGate>)
    await screen.findByLabelText('Email')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Use a static admin token/i }))
    await user.type(screen.getByLabelText('Admin token'), 'env-token-value')
    await user.click(screen.getByRole('button', { name: /^Sign in$/i }))

    expect(await screen.findByText('console body')).toBeTruthy()
    expect(sessionStorage.getItem('gw-console-admin-token')).toBe('env-token-value')
  })
})

describe('AuthGate — session restore', () => {
  it('restores an existing session without showing a form', async () => {
    storeToken('adm-stored-token')
    stubFetch({
      '/api/auth/me': () =>
        jsonResponse({
          user: { id: 'u1', email: 'ops@aether.test', createdAt: 1 },
          staticToken: false,
          expiresAt: Date.now() + 1000,
        }),
    })
    render(<AuthGate>console body</AuthGate>)
    expect(await screen.findByText('console body')).toBeTruthy()
    expect(screen.queryByLabelText('Email')).toBeNull()
  })

  it('drops a revoked session and asks to sign in again', async () => {
    storeToken('adm-revoked-token')
    stubFetch({
      '/api/auth/me': () => new Response('unauthorized', { status: 401 }),
      '/api/auth/status': () => jsonResponse({ initialized: true }),
    })
    render(<AuthGate>console body</AuthGate>)
    await waitFor(() => expect(sessionStorage.getItem('gw-console-admin-token')).toBeNull())
    expect(await screen.findByLabelText('Email')).toBeTruthy()
    expect(screen.queryByText('console body')).toBeNull()
  })
})
