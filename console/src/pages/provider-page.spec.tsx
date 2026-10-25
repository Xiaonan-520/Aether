import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  api,
  type Account,
  type ClaimJob,
  type ConsoleOverview,
  type ConsoleProvider,
  type QuotaResource,
} from '@/lib/api'
import { ProviderPage } from './provider-page'

const PROVIDER = 'workbuddycn'

function snapshot(remaining: number, total: number, unit = 'credits') {
  return {
    accountId: 'ignored',
    resources: [
      {
        id: 'credits',
        kind: 'credits',
        remaining,
        total,
        used: 0,
        unit,
        resetAt: '2026-10-31T23:59:59.000Z',
        status: 'ok',
      },
    ],
    checkedAt: '2026-10-25T03:42:29.255Z',
    source: 'authoritative',
  }
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'workbuddycn-a1',
    provider: PROVIDER,
    displayName: 'Account A',
    status: 'active',
    enabled: true,
    authenticated: true,
    tokenExpiryAt: null,
    refreshable: true,
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    cooldownUntil: null,
    quotaJson: null,
    lastQuotaAt: null,
    lastCreditClaimAt: null,
    quotaManualRequired: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function quota(overrides: Partial<QuotaResource> = {}): QuotaResource {
  const remaining = 'remaining' in overrides ? (overrides.remaining ?? null) : 1776.39
  const total = 'total' in overrides ? (overrides.total ?? null) : 1776.39
  return {
    accountId: 'workbuddycn-a1',
    accountDisplayName: 'Account A',
    known: true,
    remaining,
    total,
    resetAt: 1_793_491_199_000,
    lastUpdatedAt: 1_792_899_749_260,
    raw: snapshot(remaining ?? 0, total ?? 0),
    ...overrides,
  }
}

function provider(accounts: Account[], quotas: QuotaResource[]): ConsoleProvider {
  return {
    id: PROVIDER,
    displayName: 'WorkBuddy CN',
    capabilities: {
      supportsOAuth: false,
      supportsRefreshToken: true,
      supportsQuota: true,
      supportsCredits: false,
      supportsStreaming: true,
      supportsVision: false,
      supportsToolCall: true,
      supportsMultipleAccounts: true,
      needsCaptcha: false,
      loginMode: 'external-link',
      protocol: 'http',
    },
    accounts: {
      total: accounts.length,
      enabled: accounts.filter((item) => item.enabled).length,
      authenticated: accounts.filter((item) => item.authenticated).length,
      available: accounts.filter((item) => item.enabled && item.status === 'active').length,
      needsAttention: 0,
    },
    models: { total: 1, enabled: 1 },
    quotas,
    claim: { hasHistory: false, lastAttemptAt: null, lastOutcome: null },
    lastQuotaAt: quotas[0]?.lastUpdatedAt ?? null,
  }
}

function overview(accounts: Account[], quotas: QuotaResource[]): ConsoleOverview {
  return {
    generatedAt: 1_792_900_000_000,
    totals: {
      providers: 1,
      accounts: accounts.length,
      accountsAvailable: accounts.filter((item) => item.enabled).length,
      models: 1,
      claimsToday: { success: 0, failed: 0 },
    },
    providers: [provider(accounts, quotas)],
  }
}

function job(id: string, status: ClaimJob['status'], error: string | null = null): ClaimJob {
  return {
    id,
    provider: PROVIDER,
    accountId: 'workbuddycn-a1',
    jobType: 'quota_sync',
    scheduledAt: 1_792_899_749_000,
    startedAt: 1_792_899_749_100,
    finishedAt: 1_792_899_749_200,
    status,
    error,
    resultJson: null,
    attempts: 1,
  }
}

function stubBaseView(accounts: Account[], quotas: QuotaResource[]) {
  vi.spyOn(api, 'overview').mockResolvedValue(overview(accounts, quotas))
  vi.spyOn(api, 'accounts').mockResolvedValue({ accounts })
  vi.spyOn(api, 'providerQuotas').mockResolvedValue({ quotas })
  vi.spyOn(api, 'providerModels').mockResolvedValue({ models: [] })
  vi.spyOn(api, 'providerClaims').mockResolvedValue({ claims: [] })
}

async function openQuotaTab() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: 'Credits / Quota' }))
  return user
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('ProviderPage — per-account quota display', () => {
  it('renders both accounts with their distinct quota values', async () => {
    const accounts = [
      account({ id: 'workbuddycn-d977bc9d', displayName: 'Account A' }),
      account({ id: 'workbuddycn-076fa674', displayName: 'Account B' }),
    ]
    const quotas = [
      quota({ accountId: 'workbuddycn-d977bc9d', accountDisplayName: 'Account A' }),
      quota({
        accountId: 'workbuddycn-076fa674',
        accountDisplayName: 'Account B',
        remaining: 2000,
        total: 2000,
        raw: snapshot(2000, 2000),
      }),
    ]
    stubBaseView(accounts, quotas)

    render(<ProviderPage id={PROVIDER} onBack={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'WorkBuddy CN' })).toBeTruthy()
    await openQuotaTab()

    expect(await screen.findByText('1776.39 / 1776.39')).toBeTruthy()
    expect(screen.getByText('2000 / 2000')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Sync quota for/ })).toHaveLength(2)
  })

  it('keeps an account visible when it has no quota snapshot', async () => {
    const accounts = [
      account({ id: 'workbuddycn-d977bc9d', displayName: 'Account A' }),
      account({ id: 'workbuddycn-076fa674', displayName: 'Account B' }),
    ]
    const quotas = [quota({ accountId: 'workbuddycn-d977bc9d', accountDisplayName: 'Account A' })]
    stubBaseView(accounts, quotas)

    render(<ProviderPage id={PROVIDER} onBack={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'WorkBuddy CN' })).toBeTruthy()
    await openQuotaTab()

    const card = (await screen.findByText('Account B')).closest('[data-slot="card"]')
    expect(card).toBeTruthy()
    expect(within(card as HTMLElement).getByText('Unknown')).toBeTruthy()
    expect(within(card as HTMLElement).getByText(/never synced/)).toBeTruthy()
  })

  it('shows the last known quota for a disabled account and disables sync', async () => {
    const accounts = [
      account({ id: 'workbuddycn-d977bc9d', displayName: 'Account A' }),
      account({
        id: 'workbuddycn-076fa674',
        displayName: 'Account B',
        enabled: false,
        status: 'disabled',
      }),
    ]
    const quotas = [
      quota({ accountId: 'workbuddycn-d977bc9d', accountDisplayName: 'Account A' }),
      quota({
        accountId: 'workbuddycn-076fa674',
        accountDisplayName: 'Account B',
        remaining: 2000,
        total: 2000,
      }),
    ]
    stubBaseView(accounts, quotas)

    render(<ProviderPage id={PROVIDER} onBack={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'WorkBuddy CN' })).toBeTruthy()
    await openQuotaTab()

    const card = (await screen.findByText('Account B')).closest('[data-slot="card"]') as HTMLElement
    expect(within(card).getByText('2000 / 2000')).toBeTruthy()
    expect(within(card).getByText('Disabled')).toBeTruthy()
    expect(
      (within(card).getByRole('button', {
        name: /Sync quota for Account B/,
      }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('keeps the single-account layout to one card', async () => {
    const accounts = [account({ id: 'workbuddycn-a1', displayName: 'Account A' })]
    const quotas = [quota({ accountId: 'workbuddycn-a1', accountDisplayName: 'Account A' })]
    stubBaseView(accounts, quotas)

    render(<ProviderPage id={PROVIDER} onBack={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'WorkBuddy CN' })).toBeTruthy()
    await openQuotaTab()

    expect(await screen.findAllByRole('button', { name: /Sync quota for/ })).toHaveLength(1)
    expect(screen.getAllByText('1776.39 / 1776.39')).toHaveLength(1)
  })
})

describe('ProviderPage — refresh behavior', () => {
  it('refreshes accounts and quotas immediately after a successful login', async () => {
    let loggedIn = false
    const firstAccount = account({ id: 'workbuddycn-d977bc9d', displayName: 'Account A' })
    const secondAccount = account({ id: 'workbuddycn-076fa674', displayName: 'Account B' })
    const firstQuota = quota({ accountId: 'workbuddycn-d977bc9d', accountDisplayName: 'Account A' })
    const secondQuota = quota({
      accountId: 'workbuddycn-076fa674',
      accountDisplayName: 'Account B',
      remaining: 2000,
      total: 2000,
    })

    vi.spyOn(api, 'overview').mockImplementation(async () =>
      overview(loggedIn ? [firstAccount, secondAccount] : [firstAccount], loggedIn ? [firstQuota, secondQuota] : [firstQuota]),
    )
    vi.spyOn(api, 'accounts').mockImplementation(async () => ({
      accounts: loggedIn ? [firstAccount, secondAccount] : [firstAccount],
    }))
    vi.spyOn(api, 'providerQuotas').mockImplementation(async () => ({
      quotas: loggedIn ? [firstQuota, secondQuota] : [firstQuota],
    }))
    const beginLogin = vi.spyOn(api, 'beginLogin').mockResolvedValue({
      login_id: 'login-1',
      provider: PROVIDER,
      status: 'pending',
      authorization_url: 'https://example.test/authorize',
      expires_in: 600,
      poll_interval: 1,
    })
    vi.spyOn(api, 'pollLogin').mockImplementation(async () => {
      loggedIn = true
      return {
        login_id: 'login-1',
        provider: PROVIDER,
        status: 'success',
        account: { displayName: 'Account B' },
      }
    })

    render(<ProviderPage id={PROVIDER} onBack={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'WorkBuddy CN' })).toBeTruthy()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add account' }))
    await user.click(await screen.findByRole('button', { name: 'Begin login' }))
    expect(beginLogin).toHaveBeenCalledWith(PROVIDER)
    expect(await screen.findByText(/Login recorded by the core/, {}, { timeout: 2500 })).toBeTruthy()

    await waitFor(() => expect(api.overview).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(api.accounts).toHaveBeenCalledTimes(2))

    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await openQuotaTab()
    expect(await screen.findByText('1776.39 / 1776.39')).toBeTruthy()
    expect(screen.getByText('2000 / 2000')).toBeTruthy()
  })

  it('syncs only the selected account and refreshes when its job completes', async () => {
    const accounts = [
      account({ id: 'workbuddycn-d977bc9d', displayName: 'Account A' }),
      account({ id: 'workbuddycn-076fa674', displayName: 'Account B' }),
    ]
    const quotas = [
      quota({ accountId: 'workbuddycn-d977bc9d', accountDisplayName: 'Account A' }),
      quota({
        accountId: 'workbuddycn-076fa674',
        accountDisplayName: 'Account B',
        remaining: 2000,
        total: 2000,
      }),
    ]
    stubBaseView(accounts, quotas)
    const trigger = vi.spyOn(api, 'triggerJob').mockResolvedValue({ jobId: 'job-a' })
    vi.spyOn(api, 'jobs').mockResolvedValue({ jobs: [job('job-a', 'done')] })

    render(<ProviderPage id={PROVIDER} onBack={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'WorkBuddy CN' })).toBeTruthy()
    const user = await openQuotaTab()
    await screen.findByText('1776.39 / 1776.39')

    const card = screen.getByText('1776.39 / 1776.39').closest('[data-slot="card"]') as HTMLElement
    await user.click(within(card).getByRole('button', { name: /Sync quota for Account A/ }))

    await waitFor(() =>
      expect(trigger).toHaveBeenCalledWith('workbuddycn-d977bc9d', 'quota-sync'),
    )
    expect(trigger).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(api.providerQuotas).toHaveBeenCalledTimes(2))
    expect(api.jobs).toHaveBeenCalledWith('quota_sync')
    expect(screen.getByText('2000 / 2000')).toBeTruthy()
  })

  it('keeps both last known values when one account sync fails', async () => {
    const accounts = [
      account({ id: 'workbuddycn-d977bc9d', displayName: 'Account A' }),
      account({ id: 'workbuddycn-076fa674', displayName: 'Account B' }),
    ]
    const quotas = [
      quota({ accountId: 'workbuddycn-d977bc9d', accountDisplayName: 'Account A' }),
      quota({
        accountId: 'workbuddycn-076fa674',
        accountDisplayName: 'Account B',
        remaining: 2000,
        total: 2000,
      }),
    ]
    stubBaseView(accounts, quotas)
    vi.spyOn(api, 'triggerJob').mockResolvedValue({ jobId: 'job-a' })
    vi.spyOn(api, 'jobs').mockResolvedValue({
      jobs: [job('job-a', 'failed', 'upstream quota timeout')],
    })

    render(<ProviderPage id={PROVIDER} onBack={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'WorkBuddy CN' })).toBeTruthy()
    const user = await openQuotaTab()
    await screen.findByText('1776.39 / 1776.39')

    const card = screen.getByText('1776.39 / 1776.39').closest('[data-slot="card"]') as HTMLElement
    const secondCard = screen.getByText('2000 / 2000').closest('[data-slot="card"]') as HTMLElement
    await user.click(within(card).getByRole('button', { name: /Sync quota for Account A/ }))

    const alert = await within(card).findByRole('alert')
    expect(alert.textContent).toContain('upstream quota timeout')
    expect(within(card).getByText('1776.39 / 1776.39')).toBeTruthy()
    expect(within(secondCard).getByText('2000 / 2000')).toBeTruthy()
    expect(api.providerQuotas).toHaveBeenCalledTimes(1)
    expect(
      (within(secondCard).getByRole('button', {
        name: /Sync quota for Account B/,
      }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })
})
