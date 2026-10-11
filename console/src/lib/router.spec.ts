import { describe, expect, it } from 'vitest'
import { parseHash } from './router'

describe('router — parseHash', () => {
  it('treats empty and root hashes as home', () => {
    expect(parseHash('')).toEqual({ name: 'home' })
    expect(parseHash('#')).toEqual({ name: 'home' })
    expect(parseHash('#/')).toEqual({ name: 'home' })
  })

  it('parses a provider route and decodes the id', () => {
    expect(parseHash('#/providers/mock')).toEqual({ name: 'provider', id: 'mock' })
    expect(parseHash('#/providers/zcode%2Bcn')).toEqual({ name: 'provider', id: 'zcode+cn' })
    expect(parseHash('#/providers/workbuddycn/extra')).toEqual({
      name: 'provider',
      id: 'workbuddycn',
    })
  })

  it('falls back to home for unknown segments', () => {
    expect(parseHash('#/settings')).toEqual({ name: 'home' })
    expect(parseHash('#/providers')).toEqual({ name: 'home' })
  })

  it('parses extensions list and detail routes', () => {
    expect(parseHash('#/extensions')).toEqual({ name: 'extensions' })
    expect(parseHash('#/extensions/workbuddycn')).toEqual({ name: 'extension', id: 'workbuddycn' })
    expect(parseHash('#/extensions/gw%2Bext')).toEqual({ name: 'extension', id: 'gw+ext' })
  })
})

describe('router — keys route', () => {
  it('parses the #/keys route', async () => {
    const { parseHash } = await import('./router')
    expect(parseHash('#/keys')).toEqual({ name: 'keys' })
    expect(parseHash('#/keys/extra')).toEqual({ name: 'keys' })
  })
})
