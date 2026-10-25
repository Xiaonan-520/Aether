import { describe, expect, it } from 'vitest'
import type { QuotaResource } from './api'
import { quotaSource, quotaUnit, readAccountQuota, summarizeQuotas } from './quota-display'

function snapshot(unit: string, remaining: number | null, total: number | null, kind = 'credits') {
  return {
    accountId: 'ignored',
    resources: [
      {
        id: kind === 'credits' ? 'credits' : 'balance',
        kind,
        remaining,
        total,
        used: null,
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
  const remaining = 'remaining' in overrides ? (overrides.remaining ?? null) : 100
  const total = 'total' in overrides ? (overrides.total ?? null) : 100
  return {
    accountId: 'workbuddycn-a1',
    accountDisplayName: 'account-a1',
    known: true,
    remaining,
    total,
    resetAt: null,
    lastUpdatedAt: 1_700_000_000_000,
    raw: snapshot('credits', remaining, total),
    ...overrides,
  }
}

describe('quota display summary', () => {
  it('sums accounts that report the same resource and unit', () => {
    const summary = summarizeQuotas([
      quota({ accountId: 'a1', remaining: 1776.39, total: 1776.39 }),
      quota({ accountId: 'a2', remaining: 2000, total: 2000 }),
    ])
    expect(summary.kind).toBe('aggregate')
    if (summary.kind !== 'aggregate') return
    expect(summary.accountCount).toBe(2)
    expect(summary.knownCount).toBe(2)
    expect(summary.unknownCount).toBe(0)
    expect(summary.value).toBe('3776.39 / 3776.39')
    expect(summary.unit).toBe('credits')
  })

  it('counts unknown accounts separately instead of treating them as zero', () => {
    const summary = summarizeQuotas([
      quota({ accountId: 'a1', remaining: 1776.39, total: 1776.39 }),
      quota({
        accountId: 'a2',
        known: false,
        remaining: null,
        total: null,
        lastUpdatedAt: null,
        raw: { accountId: 'a2', resources: [], checkedAt: '2026-10-25T00:00:00.000Z', source: 'cached' },
      }),
    ])
    expect(summary.kind).toBe('aggregate')
    if (summary.kind !== 'aggregate') return
    expect(summary.knownCount).toBe(1)
    expect(summary.unknownCount).toBe(1)
    expect(summary.value).toBe('1776.39 / 1776.39')
  })

  it('lists accounts instead of inventing a total when units differ', () => {
    const summary = summarizeQuotas([
      quota({ accountId: 'a1', remaining: 1776.39, total: 1776.39 }),
      quota({
        accountId: 'a2',
        remaining: 20,
        total: 20,
        raw: snapshot('USD', 20, 20),
      }),
    ])
    expect(summary.kind).toBe('list')
    if (summary.kind !== 'list') return
    expect(summary.accountCount).toBe(2)
    expect(summary.items.map((item) => item.value)).toEqual(['1776.39 / 1776.39', '20 / 20'])
    expect(summary.items.map((item) => item.unit)).toEqual(['credits', 'USD'])
  })

  it('lists accounts instead of summing when a legacy snapshot has no resource unit', () => {
    const summary = summarizeQuotas([
      quota({
        accountId: 'a1',
        remaining: 10,
        total: 10,
        raw: { known: true, remaining: 10, total: 10 },
      }),
      quota({
        accountId: 'a2',
        remaining: 20,
        total: 20,
        raw: { known: true, remaining: 20, total: 20 },
      }),
    ])
    expect(summary.kind).toBe('list')
    if (summary.kind !== 'list') return
    expect(summary.items.map((item) => item.value)).toEqual(['10 / 10', '20 / 20'])
  })

  it('keeps the original concise shape for a single account', () => {
    const summary = summarizeQuotas([quota({ remaining: 1776.39, total: 1776.39 })])
    expect(summary).toMatchObject({
      kind: 'single',
      value: '1776.39 / 1776.39',
      unknown: false,
    })
  })

  it('reads unit and source from a single-resource V1 snapshot', () => {
    const raw = snapshot('credits', 10, 10)
    expect(quotaUnit(raw)).toBe('credits')
    expect(quotaSource(raw)).toBe('authoritative')
  })

  it('projects a V1 account snapshot for the Accounts table', () => {
    const projected = readAccountQuota(
      JSON.stringify({
        accountId: 'a1',
        resources: [
          {
            id: 'credits',
            kind: 'credits',
            remaining: 84.15,
            total: 84.15,
            used: 0,
            unit: 'credits',
            resetAt: '2026-10-31T15:59:59.000Z',
            status: 'ok',
          },
        ],
        checkedAt: '2026-10-25T00:00:00.000Z',
        source: 'authoritative',
      }),
    )
    expect(projected).toMatchObject({
      known: true,
      remaining: 84.15,
      total: 84.15,
      unit: 'credits',
    })
    expect(projected?.resetAt).toBe(Date.parse('2026-10-31T15:59:59.000Z'))
  })

  it('projects the scarcest routable resource from a multi-resource V1 snapshot', () => {
    const projected = readAccountQuota(
      JSON.stringify({
        accountId: 'a1',
        resources: [
          { id: 'credits', kind: 'credits', remaining: 500, total: 1000, used: 500, unit: 'credits', resetAt: null, status: 'ok' },
          { id: 'requests', kind: 'requests', remaining: 3, total: 50, used: 47, unit: 'requests', resetAt: null, status: 'low' },
        ],
        checkedAt: '2026-10-25T00:00:00.000Z',
        source: 'authoritative',
      }),
    )
    expect(projected).toMatchObject({ known: true, remaining: 3, total: 50, unit: 'requests' })
  })

  it('keeps legacy flat quota JSON readable', () => {
    const projected = readAccountQuota(
      JSON.stringify({ known: true, remaining: 42, total: 100, resetAt: null }),
    )
    expect(projected).toMatchObject({ known: true, remaining: 42, total: 100, unit: null })
  })
})
