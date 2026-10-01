/**
 * TRAE protocol primitives, including the deterministic device-identity
 * derivations and the OpenAI → SOLO request-body transform.
 *
 * Verified reference: jet-hub src/trae.ts. The derivations are SHA-256 seeded
 * pseudo-random streams — they are ported exactly, not re-invented, because a
 * different derivation would produce a different device identity and could trip
 * upstream risk control.
 */
import { createHash } from 'node:crypto'
import type { TraeProduct } from './product.js'
import { TRAE_DEFAULT_MODEL, TRAE_FUNCTION } from './product.js'

export type Fetcher = typeof fetch

/** Persisted TRAE credential. `machine_id` / `device_id` MUST be persisted. */
export interface TraeCredential {
  /** `Authorization: Cloud-IDE-JWT <access_token>` */
  access_token: string
  /** rotated on every ExchangeToken — must be written back */
  refresh_token: string
  expires_at?: string
  uid?: string
  nickname?: string
  /** 32-hex device fingerprint; never regenerate per refresh */
  machine_id: string
  /** 16-digit check-in device number; must differ per account */
  device_id: string
}

// -- deterministic identity derivation (ported verbatim) --------------------

function seededStream(seed: string, salt: string, nbytes: number): number[] {
  const prefix = `${salt}:${seed}`
  const result: number[] = []
  let counter = 0
  while (result.length < nbytes) {
    const counterBuf = Buffer.alloc(4)
    counterBuf.writeUInt32BE(counter >>> 0, 0)
    const digest = createHash('sha256').update(prefix, 'utf8').update(counterBuf).digest()
    for (const byte of digest) {
      if (result.length >= nbytes) break
      result.push(byte)
    }
    counter += 1
  }
  return result
}

function seededDigits(n: number, seed: string, salt: string): string {
  const bytes = seededStream(seed, salt, n * 2)
  let out = ''
  for (let i = 0; i < n; i += 1) {
    const value = (bytes[i * 2]! * 256 + bytes[i * 2 + 1]!) % 10
    out += String(value)
  }
  return out
}

/** Deterministic 15-digit device id derived from a user id. */
export function deriveDeviceId15(userId: string): string {
  return seededDigits(15, userId, 'devid')
}

/** Deterministic UUID-v4-shaped market user id derived from a user id. */
export function deriveMarketUserId(userId: string): string {
  const bs = seededStream(userId, 'market', 16)
  bs[6] = ((bs[6]! & 0x0f) | 0x40) & 0xff
  bs[8] = ((bs[8]! & 0x3f) | 0x80) & 0xff
  const hex = bs.map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Deterministic 64-hex session id derived from a user id. */
export function deriveSessionId(userId: string): string {
  return seededStream(userId, 'sess', 32).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Fresh device identity generated at login (account-scoped, never shared). */
export function newTraeDeviceIdentity(random: () => number = Math.random): { machine_id: string; device_id: string } {
  const machineId = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('')
  let deviceId = ''
  for (let i = 0; i < 16; i += 1) deviceId += String(Math.floor(random() * 10))
  return { machine_id: machineId, device_id: deviceId }
}

// -- headers ----------------------------------------------------------------

/**
 * SOLO chat / model-list headers. Several headers repeat the same token value
 * (Authorization / X-Cloudide-Token / X-Ide-Token); omitting any can be refused.
 */
export function traeSOLOHeaders(
  credential: TraeCredential,
  product: TraeProduct,
  stream: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': product.userAgent,
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    'X-Cloudide-Token': credential.access_token,
    'X-Ide-Token': credential.access_token,
    'X-Uid': credential.uid ?? '',
    'X-App-Id': product.appId,
    'X-App-Version': 'default',
    'X-Ide-Version': product.ideVersion,
    'X-Ide-Version-Code': product.ideVersionCode,
    'X-App-Version-Code': product.ideVersionCode,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'macos',
    'X-OS-Version': product.osVersion,
    'X-Device-Brand': product.deviceBrand,
    'Request-Traffic-Type': 'prod',
  }
  if (credential.machine_id.length > 0) headers['X-Machine-Id'] = credential.machine_id
  if (credential.device_id.length > 0) headers['X-Device-Id'] = credential.device_id
  return headers
}

/**
 * Check-in (ug) headers. The device id is derived from the user id so each
 * account carries its own stable identity — the upstream enforces a per-device
 * daily quota, so sharing one across accounts would block the second account.
 */
export function traeCheckinHeaders(credential: TraeCredential, product: TraeProduct, userId: string): Record<string, string> {
  const deviceId = deriveDeviceId15(userId)
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': product.userAgent,
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    'X-User-Region': product.site === 'cn' ? 'CN' : 'US',
    'X-Device-Id': deviceId,
    'X-Market-User-ID': deriveMarketUserId(userId),
    'X-Lscbd-Aid': String(Math.floor(Math.random() * 9_000) + 1_000),
    'X-Lgw-Req-Sdk-Type': 'native',
    'Package-Type': 'stable',
    'X-Tt-Trace-Id': deriveSessionId(userId),
    'Vscode-Sessionid': deriveSessionId(userId),
  }
}

// -- OpenAI → SOLO transform -------------------------------------------------

function normalizeToolChoice(body: Record<string, unknown>): void {
  const tc = body.tool_choice
  if (tc === undefined) return
  const suppress = (): void => {
    delete body.tools
    delete body.functions
  }
  if (typeof tc === 'string') {
    if (tc.toLowerCase().trim() === 'none') {
      delete body.tool_choice
      suppress()
    }
    return
  }
  if (typeof tc === 'object' && tc !== null) {
    const v = tc as Record<string, unknown>
    const type = typeof v.type === 'string' ? v.type.toLowerCase().trim() : ''
    if (type === 'none') {
      delete body.tool_choice
      suppress()
    } else if (type === 'auto' || type === 'required') {
      body.tool_choice = type
    } else if (type === 'function') {
      const fn = typeof v.function === 'object' && v.function !== null ? (v.function as Record<string, unknown>) : {}
      const name = typeof fn.name === 'string' ? fn.name : ''
      if (name.length > 0) body.tool_choice = name
      else delete body.tool_choice
    }
  }
}

function normalizeTools(body: Record<string, unknown>): void {
  const tools = body.tools
  if (!Array.isArray(tools)) return
  body.tools = tools.map((tool) => {
    if (typeof tool !== 'object' || tool === null) return tool
    const t = { ...(tool as Record<string, unknown>) }
    const fn = typeof t.function === 'object' && t.function !== null ? { ...(t.function as Record<string, unknown>) } : undefined
    if (fn && typeof fn.parameters === 'object' && fn.parameters !== null) {
      // SOLO expects `parameters` as a JSON string
      fn.parameters = JSON.stringify(fn.parameters)
    }
    if (fn) t.function = fn
    return t
  })
}

function transformSOLOMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...msg }
  if (result.role === 'assistant') {
    const tcs = result.tool_calls
    if (Array.isArray(tcs)) {
      const kept: unknown[] = []
      for (const tc of tcs) {
        if (typeof tc !== 'object' || tc === null) continue
        const t = { ...(tc as Record<string, unknown>) }
        // SOLO names the field `function_call`, not `function`
        if (typeof t.function === 'object' && t.function !== null) {
          t.function_call = t.function
          delete t.function
        }
        const fc = t.function_call as Record<string, unknown> | undefined
        if (fc === undefined || typeof fc.name !== 'string' || fc.name.trim().length === 0) continue
        kept.push(t)
      }
      if (kept.length > 0) result.tool_calls = kept
      else delete result.tool_calls
    }
  }
  const content = result.content
  if (typeof content === 'string') {
    // SOLO wants content parts
    result.content = [{ type: 'text', text: content }]
  }
  return result
}

/**
 * Convert an OpenAI chat body into SOLO form:
 * content → parts, `stream` forced true, model → config_name + model,
 * `function` = channel, tool_choice/tools normalized, parameters stringified.
 */
export function transformToSOLOBody(
  openaiBody: Record<string, unknown>,
  channel?: string,
  modelMapping?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...openaiBody,
    stream: true,
    function: channel !== undefined && channel.length > 0 ? channel : TRAE_FUNCTION,
  }
  const msgs = body.messages
  if (Array.isArray(msgs)) {
    body.messages = msgs.map((m) => transformSOLOMessage(m as Record<string, unknown>))
  }
  const model = typeof body.model === 'string' ? body.model : ''
  const baseModel = model.includes('__') ? model.split('__')[0]! : model
  const configName = modelMapping && modelMapping.length > 0 ? modelMapping : baseModel || TRAE_DEFAULT_MODEL
  body.config_name = configName
  body.model = configName
  normalizeToolChoice(body)
  normalizeTools(body)
  return body
}

// -- SOLO SSE → canonical chunks --------------------------------------------

/** One parsed SOLO SSE event. */
export interface TraeSoloEvent {
  event: string
  data: Record<string, unknown>
}

/** Parse a SOLO SSE byte stream into `{event, data}` records. */
export async function* parseTraeSoloEvents(
  stream: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<TraeSoloEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data = ''
  const flush = function* (): Generator<TraeSoloEvent> {
    if (data === '') {
      event = ''
      return
    }
    for (const line of data.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        yield { event: event || 'output', data: parsed }
      } catch {
        // ignore non-JSON frames
      }
    }
    event = ''
    data = ''
  }
  for await (const piece of stream) {
    buffer += typeof piece === 'string' ? piece : decoder.decode(piece, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line === '') {
        yield* flush()
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        data += (data === '' ? '' : '\n') + line.slice(5).trim()
      }
      index = buffer.indexOf('\n')
    }
  }
  yield* flush()
}

/** Parse the SOLO batch model-list response. */
export interface TraeRemoteModel {
  id: string
  name: string
  channel?: string
  isHidden: boolean
  isEnabled: boolean
  usage?: string
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseTraeConfigEntry(item: Record<string, unknown>, channel: string | undefined): TraeRemoteModel | undefined {
  const id = readString(item, 'config_name') ?? readString(item, 'model') ?? readString(item, 'name')
  if (!id) return undefined
  const usage = readString(item, 'usage')
  const switchValue = item.config_switch ?? item.switch
  return {
    id,
    name: readString(item, 'display_name') ?? readString(item, 'name') ?? id,
    ...(channel ? { channel } : {}),
    isHidden: item.is_invisible_to_user === true,
    isEnabled: switchValue === undefined ? true : Boolean(switchValue),
    ...(usage ? { usage } : {}),
  }
}

/**
 * Parse the batch model list. Filters (all required, applied here only):
 * usage must be `chat_completion`, the config switch must be on, and the model
 * must not be hidden from the user.
 */
export function parseTraeBatchModelList(
  body: unknown,
  channelPriority: readonly string[] = [],
): TraeRemoteModel[] {
  if (typeof body !== 'object' || body === null) return []
  const groups = (body as Record<string, unknown>).function_configs
  if (!Array.isArray(groups)) return []
  const rankOf = (channel: string | undefined): number => {
    if (channel === undefined) return Number.MAX_SAFE_INTEGER
    const index = channelPriority.indexOf(channel)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  const byId = new Map<string, TraeRemoteModel>()
  for (const group of groups) {
    if (typeof group !== 'object' || group === null) continue
    const g = group as Record<string, unknown>
    const channel = readString(g, 'function')
    const list = g.config_info_list
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      if (typeof raw !== 'object' || raw === null) continue
      const model = parseTraeConfigEntry(raw as Record<string, unknown>, channel)
      if (!model) continue
      if (model.usage !== undefined && model.usage !== 'chat_completion') continue
      if (model.isEnabled === false) continue
      if (model.isHidden) continue
      const incumbent = byId.get(model.id)
      if (incumbent === undefined) {
        byId.set(model.id, model)
        continue
      }
      // prefer the earlier channel; otherwise last wins
      const current = rankOf(incumbent.channel)
      if (current !== Number.MAX_SAFE_INTEGER && rankOf(model.channel) >= current) continue
      byId.set(model.id, model)
    }
  }
  return [...byId.values()]
}
