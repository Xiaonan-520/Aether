import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getStoredToken,
  storeToken,
  ApiError,
  normalizeExtensionRecord,
  extensionsApi,
} from './api'

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

  it('maps 401 to a session-expired hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('unauthorized', { status: 401 }))),
    )
    const { api } = await import('./api')
    await expect(api.overview()).rejects.toMatchObject({
      status: 401,
      message: 'Session expired — please sign in again',
    } satisfies Partial<ApiError>)
    vi.unstubAllGlobals()
  })
})

describe('api — key lifecycle client', () => {
  afterEach(() => {
    storeToken('')
    sessionStorage.clear()
    vi.unstubAllGlobals()
  })

  it('createKey POSTs name/expiry and surfaces the one-time key', async () => {
    storeToken('admin-tok')
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ id: 'k1', name: 'pi', keyPrefix: 'abcd1234', enabled: true, createdAt: 1, lastUsedAt: null, expiresAt: null, revokedAt: null, key: 'gw-abcd1234.secret' }),
          { status: 200 },
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { api } = await import('./api')
    const created = await api.createKey({ name: 'pi', expiresAt: 123 })
    expect(created.key).toBe('gw-abcd1234.secret')
    expect(fetchMock).toHaveBeenCalledWith('/api/keys', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer admin-tok' }),
      body: JSON.stringify({ name: 'pi', expiresAt: 123 }),
    }))
  })

  it('listKeys returns redacted metadata only (no key, no hash)', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ keys: [{ id: 'k1', name: 'n', keyPrefix: 'p', enabled: true, createdAt: 1, lastUsedAt: null, expiresAt: null, revokedAt: null }] }),
          { status: 200 },
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { api } = await import('./api')
    const body = await api.listKeys()
    expect(body.keys[0]).not.toHaveProperty('key')
    expect(body.keys[0]).not.toHaveProperty('keyHash')
    expect(fetchMock).toHaveBeenCalledWith('/api/keys', expect.anything())
  })

  it('revokeKey DELETEs by id', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    const { api } = await import('./api')
    expect(await api.revokeKey('k1')).toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/keys/k1', expect.objectContaining({ method: 'DELETE' }))
  })
})

describe('api — extension payload normalization', () => {
  const full = {
    extensionId: 'workbuddycn',
    name: 'workbuddycn',
    version: '1.0.9',
    image: { repo: 'local/gateway-extension-workbuddycn', tag: '1.0.9', digest: 'sha256:abc' },
    installState: 'installed',
    runtimeState: 'running',
    healthState: 'healthy',
    providers: ['workbuddy-cn'],
    providersRegistered: true,
    lastError: null,
    installedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }

  it('accepts a complete record unchanged', () => {
    expect(normalizeExtensionRecord(full)).toMatchObject({
      extensionId: 'workbuddycn',
      providers: ['workbuddy-cn'],
      complete: true,
    })
  })

  it('fills missing fields with explicit unknowns instead of throwing', () => {
    const view = normalizeExtensionRecord({ extensionId: 'sparse', installState: 'installed' })
    expect(view).not.toBeNull()
    expect(view!.version).toBeNull()
    expect(view!.image).toEqual({ repo: null, tag: null, digest: null })
    expect(view!.providers).toEqual([])
    expect(view!.installedAt).toBeNull()
    expect(view!.complete).toBe(false)
  })

  it('drops non-string providers and non-numeric timestamps', () => {
    const view = normalizeExtensionRecord({
      ...full,
      providers: ['ok', 7, null, ''],
      installedAt: 'yesterday',
    })
    expect(view!.providers).toEqual(['ok'])
    expect(view!.installedAt).toBeNull()
    expect(view!.complete).toBe(false)
  })

  it('uses the route id when the payload omits extensionId', () => {
    expect(normalizeExtensionRecord({ version: '1.0.0' }, 'from-route')!.extensionId).toBe('from-route')
    expect(normalizeExtensionRecord({ version: '1.0.0' })).toBeNull()
  })

  it('rejects an extension list body that is not an array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ extensions: 'nope' }), { status: 200 }))),
    )
    await expect(extensionsApi.list()).rejects.toMatchObject({
      status: 502,
      message: '扩展列表返回的数据格式不正确',
    } satisfies Partial<ApiError>)
    vi.unstubAllGlobals()
  })

  it('normalizes list entries and drops records without an id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              extensions: [
                { extensionId: 'good', version: '1.0.0', image: {}, providers: [] },
                { version: 'orphan' },
              ],
            }),
            { status: 200 },
          ),
        ),
      ),
    )
    const body = await extensionsApi.list()
    expect(body.extensions).toHaveLength(1)
    expect(body.skipped).toBe(1)
    expect(body.extensions[0]).toMatchObject({ extensionId: 'good', complete: false })
    vi.unstubAllGlobals()
  })
})
