import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouteErrorBoundary } from './route-error-boundary'

function Boom(): React.ReactNode {
  throw new Error('render exploded')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RouteErrorBoundary', () => {
  it('replaces a crashed page with an explanation instead of a blank screen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <RouteErrorBoundary resetKey="extensions">
        <Boom />
      </RouteErrorBoundary>,
    )
    expect(screen.getByText('页面暂时无法显示')).toBeTruthy()
    expect(screen.getByText('技术详情')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('recovers when the route changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = render(
      <RouteErrorBoundary resetKey="extensions">
        <Boom />
      </RouteErrorBoundary>,
    )
    expect(screen.getByText('页面暂时无法显示')).toBeTruthy()

    rerender(
      <RouteErrorBoundary resetKey="extension:workbuddycn">
        <div>details rendered</div>
      </RouteErrorBoundary>,
    )
    expect(screen.getByText('details rendered')).toBeTruthy()
  })

  it('retries the same route without a reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail = true
    function MaybeBoom() {
      if (fail) throw new Error('first render failed')
      return <div>recovered</div>
    }
    render(
      <RouteErrorBoundary resetKey="extensions">
        <MaybeBoom />
      </RouteErrorBoundary>,
    )
    fail = false
    await userEvent.setup().click(screen.getByRole('button', { name: '重试' }))
    expect(screen.getByText('recovered')).toBeTruthy()
  })
})
