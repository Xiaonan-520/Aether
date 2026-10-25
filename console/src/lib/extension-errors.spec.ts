import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { describeExtensionError, describeStoredError } from './extension-errors'

describe('extension errors — operator-facing explanations', () => {
  it('maps network failures to a reachable-gateway hint', () => {
    const view = describeExtensionError(new ApiError(0, 'Network error — the gateway is unreachable'))
    expect(view.summary).toBe('无法连接到网关。')
    expect(view.hint).toMatch(/网关正在运行/)
    expect(view.detail).toContain('unreachable')
  })

  it('explains a missing extension and what to do next', () => {
    const view = describeExtensionError(new ApiError(404, 'extension manager reports no such resource'), 'load')
    expect(view.summary).toBe('找不到这个扩展。')
    expect(view.hint).toMatch(/尚未安装|已经移除/)
  })

  it('explains manager outages without leaking the internal message into the summary', () => {
    const view = describeExtensionError(
      new ApiError(503, 'extension manager unreachable: connect ECONNREFUSED 172.18.0.5:9100'),
    )
    expect(view.summary).toBe('扩展服务暂时不可用。')
    expect(view.hint).toMatch(/扩展管理服务/)
    expect(view.summary).not.toContain('ECONNREFUSED')
    expect(view.detail).toContain('ECONNREFUSED')
  })

  it('turns a busy lock into wait-and-retry guidance', () => {
    const view = describeExtensionError(new ApiError(409, 'extension is busy'))
    expect(view.summary).toBe('扩展正在执行其他操作。')
    expect(view.hint).toMatch(/等待/)
  })

  it('maps install validation failures to a concrete next step', () => {
    const view = describeExtensionError(
      new ApiError(400, 'image tag "1.0.0" must match the manifest version "1.0.14"'),
      'install',
    )
    expect(view.summary).toBe('扩展包不符合安装要求。')
    expect(view.hint).toMatch(/版本号/)
  })

  it('never returns an empty detail for an unknown error', () => {
    const view = describeExtensionError(new Error('weird failure'))
    expect(view.summary).toBe('操作没有完成。')
    expect(view.detail).toBe('weird failure')
  })
})

describe('extension errors — persisted lastError', () => {
  it('recognises unreachable containers', () => {
    const view = describeStoredError('health check failed: connection refused at http://10.0.0.5:8080/health')
    expect(view.summary).toBe('扩展服务无法连接。')
    expect(view.hint).toMatch(/启动|重启/)
  })

  it('keeps the raw message available for troubleshooting', () => {
    const message = 'extension token was rejected by the extension'
    const view = describeStoredError(message)
    expect(view.summary).toBe('扩展与网关之间的认证失败。')
    expect(view.detail).toBe(message)
  })

  it('falls back to a generic explanation for unknown text', () => {
    const view = describeStoredError('something odd happened')
    expect(view.summary).toBe('扩展上次运行时出错。')
    expect(view.hint).toMatch(/重启|重新安装/)
  })
})
