/**
 * Extension list/detail rendering and recovery states.
 *
 * The detail page used to render only when the extension declared no actions;
 * with actions present, the action dialog reset its state during every render
 * and React unmounted the tree (error #301), leaving a blank page. These tests
 * render a provider that DOES declare actions to pin that regression, and cover
 * loading, not-found, manager failure and incomplete-payload states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExtensionsPage, ExtensionDetailPage } from './extensions-page'
import { storeToken } from '@/lib/api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

type Route = (input: string, init?: RequestInit) => Response | Promise<Response>

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

const NOW = 1_792_900_000_000

function record(over: Record<string, unknown> = {}) {
  return {
    extensionId: 'workbuddycn',
    name: 'workbuddycn',
    version: '1.0.9',
    image: {
      repo: 'local/gateway-extension-workbuddycn',
      tag: '1.0.9',
      digest: 'sha256:abcdef',
    },
    installState: 'installed',
    runtimeState: 'running',
    healthState: 'healthy',
    providers: ['workbuddy-cn'],
    providersRegistered: true,
    lastError: null,
    installedAt: NOW - 60_000,
    updatedAt: NOW,
    ...over,
  }
}

const ACTIONS = {
  actions: [
    {
      id: 'account-status',
      title: 'Account status',
      description: 'Read the current account status.',
      sideEffects: 'none',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      id: 'sign-in',
      title: 'Sign in',
      description: 'Start a sign-in flow.',
      sideEffects: 'mutating',
      inputSchema: {
        type: 'object',
        properties: { mobile: { type: 'string', description: 'Phone number' } },
        required: ['mobile'],
      },
    },
  ],
}

/** Routes for one detail record; the actions URL must precede the detail URL. */
function detailRoutes(rec: unknown, actions: unknown = { actions: [] }) {
  return {
    '/api/console/extensions/workbuddycn/providers/workbuddy-cn/actions/sign-in': () =>
      jsonResponse({ actionId: 'sign-in', result: { ok: true, message: 'signed in' } }),
    '/api/console/extensions/workbuddycn/providers/workbuddy-cn/actions': () =>
      jsonResponse(actions),
    '/api/console/extensions/workbuddycn': () => jsonResponse(rec),
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  storeToken('')
  sessionStorage.clear()
})

describe('ExtensionDetailPage — root cause regression', () => {
  it('renders an installed extension whose provider declares actions', async () => {
    stubFetch(detailRoutes(record(), ACTIONS))
    render(<ExtensionDetailPage id="workbuddycn" onBack={() => {}} />)

    expect(await screen.findByRole('heading', { name: /workbuddycn/ })).toBeTruthy()
    expect(screen.getAllByText('已安装').length).toBeGreaterThan(0)
    expect(screen.getAllByText('运行中').length).toBeGreaterThan(0)
    expect(screen.getAllByText('正常').length).toBeGreaterThan(0)
    expect(screen.getByText('所有模型服务均已接入网关，可以正常使用。')).toBeTruthy()
    expect(await screen.findByRole('button', { name: /Account status/ })).toBeTruthy()
    expect(await screen.findByRole('button', { name: /Sign in/ })).toBeTruthy()
  })

  it('shows the manifest display name and keeps the extension id visible', async () => {
    stubFetch(detailRoutes(record({ name: 'WorkBuddy CN' })))
    render(<ExtensionDetailPage id="workbuddycn" onBack={() => {}} />)

    expect(await screen.findByRole('heading', { name: /WorkBuddy CN/ })).toBeTruthy()
    expect(screen.getByText(/扩展标识：/)).toBeTruthy()
  })

  it('opens and closes a manifest action without unmounting the page', async () => {
    stubFetch(detailRoutes(record(), ACTIONS))
    render(<ExtensionDetailPage id="workbuddycn" onBack={() => {}} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Sign in/ }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText('此操作会修改扩展数据，请确认后执行。')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The page must still be there, not blank.
    expect(screen.getByRole('heading', { name: /workbuddycn/ })).toBeTruthy()
  })

  it('validates required action fields before invoking the extension', async () => {
    const calls = stubFetch(detailRoutes(record(), ACTIONS))
    render(<ExtensionDetailPage id="workbuddycn" onBack={() => {}} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Sign in/ }))
    await user.click(screen.getByRole('button', { name: '执行' }))

    expect(await screen.findByText('请填写：Phone number')).toBeTruthy()
    expect(calls.some((c) => c.url.includes('/actions/sign-in'))).toBe(false)
  })

  it('invokes an action and shows its result', async () => {
    stubFetch(detailRoutes(record(), ACTIONS))
    render(<ExtensionDetailPage id="workbuddycn" onBack={() => {}} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Sign in/ }))
    await user.type(screen.getByRole('textbox', { name: /Phone number/ }), '13800000000')
    await user.click(screen.getByRole('button', { name: '执行' }))

    expect(await screen.findByText('执行结果')).toBeTruthy()
    expect(await screen.findByText(/signed in/)).toBeTruthy()
  })

  it('shows a stopped extension with a start action and no reload', async () => {
    stubFetch(
      detailRoutes(
        record({ installState: 'stopped', runtimeState: 'stopped', healthState: 'unknown', providersRegistered: false }),
      ),
    )
    render(<ExtensionDetailPage id="workbuddycn" onBack={() => {}} />)

    expect(await screen.findByRole('button', { name: /启动/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /重载服务/ })).toBeNull()
    expect(screen.getByText('扩展当前未运行，启动后模型服务会自动接入。')).toBeTruthy()
  })
})

describe('ExtensionDetailPage — failure and incomplete states', () => {
  it('shows a friendly not-found state and can go back', async () => {
    let back = 0
    stubFetch({
      '/api/console/extensions/workbuddycn': () =>
        jsonResponse({ error: { code: 'extension_not_found', message: 'no such extension' } }, 404),
    })
    render(<ExtensionDetailPage id="workbuddycn" onBack={() => back++} />)

    expect(await screen.findByText('无法打开扩展')).toBeTruthy()
    expect(screen.getByText('找不到这个扩展。')).toBeTruthy()
    const backButtons = screen.getAllByRole('button', { name: '返回扩展列表' })
    expect(backButtons.length).toBeGreaterThan(0)
    await userEvent.setup().click(backButtons[0])
    expect(back).toBe(1)
  })

  it('explains a manager outage and keeps the raw detail collapsed', async () => {
    stubFetch({
      '/api/console/extensions/workbuddycn': () =>
        jsonResponse(
          { error: { code: 'manager_unavailable', message: 'extension manager unreachable: connect ECONNREFUSED 172.18.0.5:9100' } },
          503,
        ),
    })
    render(<ExtensionDetailPage id="workbuddycn" onBack={() => {}} />)

    expect(await screen.findByText('扩展服务暂时不可用。')).toBeTruthy()
    expect(screen.getByText('技术详情')).toBeTruthy()
    // The raw message lives inside <details>, not in the main explanation.
    const summary = screen.getByText('扩展服务暂时不可用。')
    expect(summary.textContent).not.toContain('ECONNREFUSED')
  })

  it('renders an incomplete payload with 未知 values instead of a blank page', async () => {
    stubFetch(
      detailRoutes({
        extensionId: 'workbuddycn',
        version: '0.9.0',
        installState: 'installed',
        runtimeState: 'running',
        healthState: 'healthy',
        providers: null,
        providersRegistered: true,
      }),
    )
    render(<ExtensionDetailPage id="workbuddycn" onBack={() => {}} />)

    expect(await screen.findByText('部分信息缺失')).toBeTruthy()
    expect(screen.getByText(/安装于 时间未知/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: /workbuddycn/ })).toBeTruthy()
  })

  it('shows an action-API failure with retry instead of silently hiding it', async () => {
    stubFetch({
      '/api/console/extensions/workbuddycn/providers/workbuddy-cn/actions': () =>
        jsonResponse({ error: { code: 'manager_error', message: 'boom' } }, 502),
      '/api/console/extensions/workbuddycn': () => jsonResponse(record()),
    })
    render(<ExtensionDetailPage id="workbuddycn" onBack={() => {}} />)

    expect(await screen.findByText('无法加载可用操作')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })
})

describe('ExtensionsPage — list states', () => {
  it('lists extensions and opens the detail route', async () => {
    const opened: string[] = []
    stubFetch({ '/api/console/extensions': () => jsonResponse({ extensions: [record()] }) })
    render(<ExtensionsPage onOpen={(id) => opened.push(id)} />)

    expect(await screen.findByText('已安装')).toBeTruthy()
    expect(screen.getByText('服务已接入')).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: '查看详情' }))
    expect(opened).toEqual(['workbuddycn'])
  })

  it('shows an empty state that leads to install', async () => {
    stubFetch({ '/api/console/extensions': () => jsonResponse({ extensions: [] }) })
    render(<ExtensionsPage onOpen={() => {}} />)

    expect(await screen.findByText('还没有安装扩展')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '安装扩展' }).length).toBeGreaterThan(1)
  })

  it('shows a load failure with retry', async () => {
    stubFetch({
      '/api/console/extensions': () =>
        jsonResponse({ error: { code: 'manager_unavailable', message: 'manager down' } }, 503),
    })
    render(<ExtensionsPage onOpen={() => {}} />)

    expect(await screen.findByText('无法加载扩展列表')).toBeTruthy()
    expect(screen.getByText('扩展服务暂时不可用。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('shows a visible loading state instead of an empty page', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    render(<ExtensionsPage onOpen={() => {}} />)
    expect(screen.getByText('正在加载扩展列表…')).toBeTruthy()
    expect(screen.getByText('扩展管理')).toBeTruthy()
  })

  it('surfaces a failed lifecycle action outside the confirmation dialog', async () => {
    stubFetch({
      '/api/console/extensions/workbuddycn/stop': () =>
        jsonResponse({ error: { code: 'manager_unavailable', message: 'manager down' } }, 503),
      '/api/console/extensions': () => jsonResponse({ extensions: [record()] }),
    })
    render(<ExtensionsPage onOpen={() => {}} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '停止' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '停止' }))

    expect(await screen.findByText('扩展服务暂时不可用。')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('heading', { name: '扩展管理' })).toBeTruthy()
  })
})

describe('ExtensionDetailPage — loading state', () => {
  it('keeps the page chrome and a back action while loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    render(<ExtensionDetailPage id="workbuddycn" onBack={() => {}} />)
    expect(screen.getByText('正在加载扩展信息…')).toBeTruthy()
    expect(screen.getByRole('button', { name: '返回扩展列表' })).toBeTruthy()
  })
})

describe('ExtensionsPage — install flow', () => {
  it('installs by image and reports success without manifest fields', async () => {
    const calls = stubFetch({
      '/api/console/extensions/install-from-image': () =>
        jsonResponse({ extensionId: 'minimax', status: 'installed', providers: [{ id: 'minimax' }] }, 201),
      '/api/console/extensions': () => jsonResponse({ extensions: [] }),
    })
    render(<ExtensionsPage onOpen={() => {}} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '安装扩展' }))
    await user.type(screen.getByLabelText('版本号'), '1.0.14')
    await user.click(screen.getByRole('button', { name: '安装' }))

    expect(await screen.findByText('扩展「minimax」已安装并接入网关。')).toBeTruthy()
    const install = calls.find((c) => c.url.includes('/install-from-image'))
    expect(JSON.parse(String(install?.init?.body))).toEqual({
      image: { repo: 'local/gateway-extension-', tag: '1.0.14' },
    })
  })

  it('explains an install validation failure in operator terms', async () => {
    stubFetch({
      '/api/console/extensions/install-from-image': () =>
        jsonResponse(
          { error: { code: 'invalid_request_error', message: 'image tag "1.0.0" must match the manifest version "1.0.14"' } },
          400,
        ),
      '/api/console/extensions': () => jsonResponse({ extensions: [] }),
    })
    render(<ExtensionsPage onOpen={() => {}} />)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '安装扩展' }))
    await user.type(screen.getByLabelText('版本号'), '1.0.0')
    await user.click(screen.getByRole('button', { name: '安装' }))

    expect(await screen.findByText('扩展包不符合安装要求。')).toBeTruthy()
    expect(screen.getByText(/版本号与扩展提供方给出的一致/)).toBeTruthy()
  })
})
