/**
 * ZCode gateway identity blocks for start-plan requests.
 *
 * Ported from TriDefender/zcode-api (`src/proxy/system-prompt.ts`, CC BY-NC-SA
 * 4.0 — see THIRD-PARTY-NOTICES.md). The start-plan edge inspects the `system`
 * field: traffic whose system blocks do not carry the ZCode identity text is
 * rejected with `3012 "This client is not supported. Please use the official
 * ZCode client."` — which is exactly what a bare Anthropic request looks like.
 * coding-plan traffic never carries these blocks, so they stay behind the
 * `start-plan` flag.
 *
 * Wire shape (three blocks, byte-identical to the client's
 * `assembleSystemMessages`):
 *   1. `cliPrefix` alone, no cache_control
 *   2. the stable identity text, `cache_control: ephemeral`
 *   3. client system text behind a `\n\n` prefix (or an empty string when the
 *      caller supplied no system prompt), `cache_control: ephemeral`
 *
 * Only the gateway identity anchor is reproduced. Environment Info / Model
 * Identity / session guidance sections are client-state dependent and omitted —
 * the minimal set is a real, common client shape.
 */
import data from './zcode-system.json' with { type: 'json' }

export interface SystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

const EPHEMERAL: { type: 'ephemeral' } = { type: 'ephemeral' }

interface SystemData {
  cliPrefix: string
  stableSections: string[]
  dynamicSections: Record<string, string>
  currentDate: { line: string }
  systemReminder: { open: string; close: string }
}

const SYSTEM_DATA = data as SystemData

/** Local `YYYY-MM-DD`, zero-padded (matches the client's date attachment). */
export function formatLocalIsoDate(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Build the three system blocks for a start-plan request.
 *
 * `existingSystem` is the caller's own system prompt (messages with role
 * `system`); when present it becomes the whole third block, which the gateway
 * validates least strictly.
 */
export function buildStartPlanSystem(existingSystem: string | undefined): SystemBlock[] {
  const custom = typeof existingSystem === 'string' && existingSystem.trim().length > 0
    ? existingSystem.trim()
    : ''
  const stable = SYSTEM_DATA.stableSections.join('\n\n')
  return [
    { type: 'text', text: SYSTEM_DATA.cliPrefix },
    { type: 'text', text: stable, cache_control: { ...EPHEMERAL } },
    { type: 'text', text: custom === '' ? '' : `\n\n${custom}`, cache_control: { ...EPHEMERAL } },
  ]
}

/**
 * The `meta_user` date attachment: a leading user turn whose single text block
 * is `Today's date is YYYY-MM-DD.` wrapped in `<system-reminder>`.
 */
export function buildCurrentDateMessage(now: Date = new Date()): { role: 'user'; content: SystemBlock[] } {
  const date = formatLocalIsoDate(now)
  const body = SYSTEM_DATA.currentDate.line.replace('{date}', date)
  return {
    role: 'user',
    content: [{ type: 'text', text: `${SYSTEM_DATA.systemReminder.open}${body}${SYSTEM_DATA.systemReminder.close}` }],
  }
}
