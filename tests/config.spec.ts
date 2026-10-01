import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/index.js'

const valid = {
  GATEWAY_API_KEY: 'gw-key',
  GATEWAY_SECRET: '0123456789abcdef',
  GATEWAY_ADMIN_TOKEN: 'admin-token',
}

describe('config', () => {
  it('applies defaults', () => {
    const cfg = loadConfig({ ...valid } as NodeJS.ProcessEnv)
    expect(cfg.dataDir).toBe('./data')
    expect(cfg.httpPort).toBe(8080)
    expect(cfg.logLevel).toBe('info')
    expect(cfg.tz).toBe('Asia/Shanghai')
    expect(cfg.httpHost).toBe('0.0.0.0')
  })

  it('rejects missing required variables', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/GATEWAY_API_KEY/)
  })

  it('rejects a short GATEWAY_SECRET', () => {
    expect(() =>
      loadConfig({ ...valid, GATEWAY_SECRET: 'short' } as NodeJS.ProcessEnv),
    ).toThrow(/GATEWAY_SECRET/)
  })

  it('coerces HTTP_PORT from string', () => {
    const cfg = loadConfig({ ...valid, HTTP_PORT: '9000' } as NodeJS.ProcessEnv)
    expect(cfg.httpPort).toBe(9000)
  })
})
