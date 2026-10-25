import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { HomePage } from './home-page'
import { api, type ConsoleOverview, type ConsoleProvider, type QuotaResource } from '@/lib/api'

type MotionDivProps = import('react').ComponentProps<'div'> & {
  initial?: unknown
  animate?: unknown
  transition?: unknown
}

// happy-dom cancels native motion animations during cleanup and can surface an
// unhandled AbortError. This test only asserts data rendering, so a plain div
// keeps the component contract without starting animations.
vi.mock('motion/react', async () => {
  const React = await import('react')
  return {
    motion: {
      div: ({ initial, animate, transition, ...props }: MotionDivProps) => {
        void initial
        void animate
        void transition
        return React.createElement('div', props)
      },
    },
  }
})

function snapshot(unit: string, remaining: number, total: number) {
  return {
    accountId: 'ignored',
    resources: [
      {
        id: unit === 'credits' ? 'credits' : 'balance',
        kind: 'credits',
        remaining,
        total,
        used: 0,
        unit,
        resetAt: null,
        status: 'ok',
      },
    ],
    checkedAt: '2026-10-25T00:00:00.000Z',
    source: 'authoritative',
  }
}

function quota(overrides: Partial<QuotaResource> = {}): QuotaResource {
  const remaining = 'remaining' in overrides ? (overrides.remaining ?? null) : 1776.39
  const total = 'total' in overrides ? (overrides.total ?? null) : 1776.39
  return {
    accountId: 'workbuddycn-a1',
    accountDisplayName: 'workbuddycn-a1',
    known: true,
    remaining,
    total,
    resetAt: 1_793_491_199_000,
    lastUpdatedAt: 1_792_899_749_260,
    raw: snapshot('credits', remaining ?? 0, total ?? 0),
    ...overrides,
  }
}

function provider(quotas: QuotaResource[]): ConsoleProvider {
  return {
    id: 'workbuddycn',
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
      total: quotas.length,
      enabled: quotas.length,
      authenticated: quotas.length,
      available: quotas.length,
      needsAttention: 0,
    },
    models: { total: 1, enabled: 1 },
    quotas,
    claim: { hasHistory: false, lastAttemptAt: null, lastOutcome: null },
    lastQuotaAt: quotas[0]?.lastUpdatedAt ?? null,
  }
}

function overview(quotas: QuotaResource[]): ConsoleOverview {
  return {
    generatedAt: 1_792_900_000_000,
    totals: {
      providers: 1,
      accounts: quotas.length,
      accountsAvailable: quotas.length,
      models: 1,
      claimsToday: { success: 0, failed: 0 },
    },
    providers: [provider(quotas)],
  }
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

describe('HomePage — multi-account quota summary', () => {
  it('shows an explicit aggregate instead of hiding the second account', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue(
      overview([
        quota({ accountId: 'workbuddycn-d977bc9d', accountDisplayName: 'workbuddycn-d977bc9d' }),
        quota({
          accountId: 'workbuddycn-076fa674',
          accountDisplayName: 'workbuddycn-076fa674',
          remaining: 2000,
          total: 2000,
        }),
      ]),
    )

    render(<HomePage />)

    expect(await screen.findByText('3776.39 / 3776.39')).toBeTruthy()
    expect(screen.getByText('credits')).toBeTruthy()
    expect(screen.getByText('2 accounts')).toBeTruthy()
    // The old single-account value must not masquerade as the provider total.
    expect(screen.queryByText('1776.39 / 1776.39')).toBeNull()
  })

  it('reports unknown accounts separately instead of summing them as zero', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue(
      overview([
        quota({ accountId: 'a1' }),
        quota({
          accountId: 'a2',
          known: false,
          remaining: null,
          total: null,
          lastUpdatedAt: null,
          raw: { accountId: 'a2', resources: [], checkedAt: '2026-10-25T00:00:00.000Z' },
        }),
      ]),
    )

    render(<HomePage />)

    expect(await screen.findByText('1776.39 / 1776.39')).toBeTruthy()
    expect(screen.getByText(/1 unknown account/)).toBeTruthy()
    expect(screen.getByText(/total covers known accounts only/)).toBeTruthy()
  })

  it('lists per-account values when units differ instead of inventing a total', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue(
      overview([
        quota({ accountId: 'a1', accountDisplayName: 'account-a1' }),
        quota({
          accountId: 'a2',
          accountDisplayName: 'account-a2',
          remaining: 20,
          total: 20,
          raw: snapshot('USD', 20, 20),
        }),
      ]),
    )

    render(<HomePage />)

    expect(await screen.findByText(/per-account quotas/)).toBeTruthy()
    expect(screen.getByText('1776.39 / 1776.39 credits')).toBeTruthy()
    expect(screen.getByText('20 / 20 USD')).toBeTruthy()
    expect(screen.queryByText('2 accounts')).toBeNull()
  })

  it('keeps the original concise shape for a single account', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue(overview([quota({ accountId: 'only-account' })]))

    render(<HomePage />)

    expect(await screen.findByText('1776.39 / 1776.39')).toBeTruthy()
    expect(screen.queryByText(/across/)).toBeNull()
    expect(screen.queryByText(/per-account quotas/)).toBeNull()
  })
})
