import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStoredToken, storeToken, ApiError } from './api'

describe('api — admin token storage', () => {
  afterEach(() => {
    storeToken('')
    sessionStorage.clear()
  })

  it('stores and clears the token in sessionStorage only', () => {
    expect(getStoredToken()).toBe('')
    storeToken('secret-token')
    expect(getStoredToken()).toBe('secret-token')
    expect(sessionStorage.getItem('gw-console-admin-token')).toBe('secret-token')
    storeToken('')
    expect(getStoredToken()).toBe('')
  })
})

describe('api — request error mapping', () => {
  it('maps network failures to a friendly ApiError with status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    )
    const { api } = await import('./api')
    await expect(api.overview()).rejects.toMatchObject({
      status: 0,
      message: 'Network error — the gateway is unreachable',
    } satisfies Partial<ApiError>)
    vi.unstubAllGlobals()
  })

  it('attaches the Bearer token from storage to every request', async () => {
    storeToken('tok-123')
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { api } = await import('./api')
    await api.overview()
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
    vi.unstubAllGlobals()
  })

  it('surfaces the core error message on failure responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'unknown provider "x"' } }), {
            status: 404,
          }),
        ),
      ),
    )
    const { api } = await import('./api')
    await expect(api.providerModels('x')).rejects.toMatchObject({
      status: 404,
      message: 'unknown provider "x"',
    } satisfies Partial<ApiError>)
    vi.unstubAllGlobals()
  })

  it('maps 401 to an explicit unauthorized hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('unauthorized', { status: 401 }))),
    )
    const { api } = await import('./api')
    await expect(api.overview()).rejects.toMatchObject({
      status: 401,
      message: 'Unauthorized — check the admin token',
    } satisfies Partial<ApiError>)
    vi.unstubAllGlobals()
  })
})
