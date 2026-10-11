#!/usr/bin/env node
/**
 * Unified WeChat progress notification formatter for the Gateway M0 task.
 *
 * Usage:
 *   node scripts/wx-notify.mjs '<type>' '<stage>' '<status>' --json '<json-payload>'
 *
 * type:   start | progress | alert | done
 * stage:  free-text stage label, e.g. "阶段 C — Core→Manager 管理 API"
 * status: 进行中 | 已完成 | 阻塞
 * json-payload: { done: string[], doing: string, results: string[], next: string[], risks: string[], plan: string }
 *
 * Renders the unified mobile-friendly format to wbcn-m0-notify.txt (gitignored)
 * for the agent to deliver via its file-send channel. Single writer, single
 * output file — notification content always comes from real plan/test state.
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , type = 'progress', stage = '', status = '进行中'] = process.argv
const jsonIdx = process.argv.indexOf('--json')
const payload = jsonIdx >= 0 ? JSON.parse(process.argv[jsonIdx + 1] ?? '{}') : {}

const TITLE = {
  start: '【Gateway M0｜任务启动】',
  progress: '【Gateway M0｜阶段进度】',
  alert: '【Gateway M0｜⚠ 需要关注】',
  done: '【Gateway M0｜任务完成】',
}[type] ?? '【Gateway M0｜阶段进度】'

const section = (heading, items) => {
  if (!items || (Array.isArray(items) && items.length === 0)) return ''
  const lines = Array.isArray(items) ? items : [items]
  return `\n${heading}：\n${lines.map((l) => `- ${l}`).join('\n')}\n`
}

let msg = `${TITLE}\n\n阶段：${stage}\n状态：${status}\n`
msg += section('已完成', payload.done)
msg += section('验证结果', payload.results)
if (payload.doing) msg += `\n当前工作：\n- ${payload.doing}\n`
msg += section('下一步', payload.next)
msg += section('风险/阻塞', payload.risks && payload.risks.length ? payload.risks : (type === 'alert' ? undefined : ['无']))
if (payload.plan) msg += `\nPlan：${payload.plan}\n`

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'wbcn-m0-notify.txt')
writeFileSync(out, msg.replace(/\n{3,}/g, '\n\n').trim() + '\n')
console.log(`wrote ${out}`)
