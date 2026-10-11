/**
 * Pure parsing helpers for WorkBuddyCN responses. Mirror the behavior of the
 * upstream `buddy` provider (buddy.ts). Converts upstream wire values into
 * normalized Extension-facing types. No I/O, no credentials leaked.
 */
import type { Credential } from '../../storage/store.js'
import {
  DEFAULT_MODEL,
  MODEL_DISPLAY_NAMES,
} from './paths.js'
import { FALLBACK_MODELS } from '../../protocol/manifest.js'
import type { ProtocolModelInfo } from '../../protocol/types.js'

/** Parse a token/refresh response's `data` object. */
export interface RawTokenData {
  accessToken: string
  refreshToken: string
  expiresAt: string
  refreshExpiresAt: string
  tokenType: string
  scope: string
  domain: string
}

export interface RawAccountData {
  uid: string
  nickname: string
  enterpriseId: string
  accountType: string
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value === 'string') return stripControl(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

function stripControl(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** Read an absolute expiry (ms epoch). Falls back to relative seconds anchored on JWT iat/exp. */
function absoluteExpiry(record: Record<string, unknown>, absoluteKey: string, relativeKey: string, access: string): string {
  const absolute = stringField(record, absoluteKey)
  if (absolute.length > 0) {
    const asNumber = /^\d+$/.test(absolute) ? Number(absolute) : Date.parse(absolute)
    if (Number.isFinite(asNumber)) {
      const ms = asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000
      return String(ms)
    }
    return absolute
  }
  const relative = numberField(record, relativeKey)
  if (relative === undefined) return ''
  const base = jwtNumericClaim(access, 'iat') ?? Date.now()
  return String(base + relative * 1000)
}

function jwtNumericClaim(token: string, claim: 'iat' | 'exp'): number | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    const value = payload[claim]
    return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined
  } catch {
    return undefined
  }
}

export function parseTokenData(data: unknown): RawTokenData {
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  const accessToken = stringField(record, 'accessToken')
  const tokenType = stringField(record, 'tokenType')
  return {
    accessToken,
    refreshToken: stringField(record, 'refreshToken'),
    expiresAt: absoluteExpiry(record, 'expiresAt', 'expiresIn', accessToken),
    refreshExpiresAt: absoluteExpiry(record, 'refreshExpiresAt', 'refreshExpiresIn', accessToken),
    tokenType: tokenType.length > 0 ? tokenType : 'Bearer',
    scope: stringField(record, 'scope'),
    domain: stringField(record, 'domain'),
  }
}

export function parseAccountData(data: unknown): RawAccountData {
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  const accountType = stringField(record, 'type')
  return {
    uid: stringField(record, 'uid'),
    nickname: stringField(record, 'nickname'),
    enterpriseId: stringField(record, 'enterpriseId'),
    accountType: accountType.length > 0 ? accountType : 'personal',
  }
}

function jwtStringClaim(token: string, claim: string): string {
  if (typeof token !== 'string' || token.length === 0) return ''
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    const value = payload[claim]
    return typeof value === 'string' ? stripControl(value) : ''
  } catch {
    return ''
  }
}

/** Combine token + account into a stored credential. */
export function buildCredential(token: RawTokenData, account: RawAccountData): Credential {
  const nickname = account.nickname.length > 0
    ? account.nickname
    : jwtStringClaim(token.accessToken, 'nickname') || jwtStringClaim(token.accessToken, 'preferred_username')
  return {
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    refresh_expires_at: token.refreshExpiresAt,
    token_type: token.tokenType.length > 0 ? token.tokenType : 'Bearer',
    scope: token.scope,
    domain: token.domain,
    user_id: account.uid.length > 0 ? account.uid : jwtStringClaim(token.accessToken, 'sub'),
    nickname,
    enterprise_id: account.enterpriseId,
    account_type: account.accountType,
  }
}

/** Parse an absolute expiry (ms). Compatible with ms/seconds/ISO. Falls back to JWT exp. */
export function credentialExpiresAtMs(credential: Pick<Credential, 'expires_at'> & { access_token?: string }): number | undefined {
  const raw = credential.expires_at
  if (typeof raw === 'string' && raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw)
      return value > 1_000_000_000_000 ? value : value * 1000
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return jwtNumericClaim(credential.access_token ?? '', 'exp')
}

export function isExpired(credential: Credential): boolean {
  const expiresAt = credentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : Date.now() >= expiresAt
}

export function isRefreshable(credential: Credential): boolean {
  return credential.refresh_token.length > 0
}

// ── model catalog parsing ───────────────────────────────────────
export interface RemoteModel {
  id: string
  name: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsImages?: boolean
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string
}

interface ConfigPayload {
  models: RemoteModel[]
  promotions: Map<string, string>
}

const PREFERRED_AGENT_NAMES = ['cli', 'craft'] as const

function isAutoSelectAlias(id: string): boolean {
  return id === 'auto' || id === 'default'
}

function isChatModel(id: string, meta: Record<string, unknown> | undefined): boolean {
  if (id.startsWith('nes-') || id.startsWith('completion-') || id.startsWith('codewise-')) return false
  if (meta?.supportsExtra === true) return false
  const maxOutput = meta?.maxOutputTokens
  if (typeof maxOutput === 'number' && maxOutput > 0 && maxOutput <= 256) return false
  const tags = meta?.tags
  if (Array.isArray(tags) && tags.some((tag) => tag === 'text-to-image')) return false
  return true
}

function parseModelMeta(record: Record<string, unknown> | undefined): Omit<RemoteModel, 'id' | 'name'> {
  if (record === undefined) return {}
  const meta: Omit<RemoteModel, 'id' | 'name'> = {}
  const limit = record.maxInputTokens
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) meta.contextWindow = limit
  const maxOutput = record.maxOutputTokens
  if (typeof maxOutput === 'number' && Number.isFinite(maxOutput) && maxOutput > 0) meta.maxOutputTokens = maxOutput
  if (typeof record.supportsImages === 'boolean') meta.supportsImages = record.supportsImages
  const reasoning = record.reasoning
  if (typeof reasoning === 'object' && reasoning !== null) {
    const fields = reasoning as Record<string, unknown>
    if (Array.isArray(fields.supportedEfforts)) {
      const efforts = fields.supportedEfforts.filter((e): e is string => typeof e === 'string' && e.length > 0)
      if (efforts.length > 0) meta.reasoningEfforts = efforts
    }
    if (typeof fields.defaultEffort === 'string' && fields.defaultEffort.length > 0) {
      meta.defaultReasoningEffort = fields.defaultEffort
    }
  }
  return meta
}

function promotionActiveNow(item: Record<string, unknown>, now: Date): boolean {
  if (typeof item.schedule !== 'object' || item.schedule === null) return true
  const schedule = item.schedule as Record<string, unknown>
  const from = typeof schedule.validFrom === 'string' ? Date.parse(schedule.validFrom) : Number.NaN
  const until = typeof schedule.validUntil === 'string' ? Date.parse(schedule.validUntil) : Number.NaN
  if (Number.isFinite(from) && now.getTime() < from) return false
  if (Number.isFinite(until) && now.getTime() >= until) return false
  return true
}

export function parsePromotions(record: Record<string, unknown>, now: Date = new Date()): Map<string, string> {
  const result = new Map<string, string>()
  const chosen = new Map<string, number>()
  const promotions = record.modelPromotions
  if (!Array.isArray(promotions)) return result
  const sorted = [...promotions].sort((a, b) => {
    const pa = typeof a === 'object' && a !== null ? ((a as Record<string, unknown>).priority ?? 0) : 0
    const pb = typeof b === 'object' && b !== null ? ((b as Record<string, unknown>).priority ?? 0) : 0
    return Number(pa) - Number(pb)
  })
  for (const item of sorted) {
    if (typeof item !== 'object' || item === null) continue
    const promotion = item as Record<string, unknown>
    if (promotion.enabled === false) continue
    if (!promotionActiveNow(promotion, now)) continue
    const discount = promotion.discount
    if (typeof discount !== 'object' || discount === null) continue
    const factor = (discount as Record<string, unknown>).factor
    const modelIds = promotion.modelIds
    if (!Array.isArray(modelIds)) continue
    if (typeof factor === 'number' && factor === 0) continue // no-window "free" placeholder ignored
    for (const id of modelIds) {
      if (typeof id !== 'string' || id.length === 0) continue
      result.set(id, 'promoted')
    }
  }
  return result
}

function trialModelIds(data: Record<string, unknown>): string[] {
  const features = data.productFeaturesConfig
  if (typeof features !== 'object' || features === null) return []
  const banner = (features as Record<string, unknown>).ModelTrialBanner
  if (typeof banner !== 'object' || banner === null) return []
  const banners = (banner as Record<string, unknown>).banners
  if (!Array.isArray(banners)) return []
  const ids: string[] = []
  for (const item of banners) {
    if (typeof item !== 'object' || item === null) continue
    const target = (item as Record<string, unknown>).targetModelId
    if (typeof target === 'string' && target.length > 0) ids.push(target)
  }
  return ids
}

/** Parse a /v3/config or scoped-model response body into chat-capable models. */
export function parseModelsFromConfig(body: unknown): RemoteModel[] {
  if (typeof body !== 'object' || body === null) return []
  const data = (body as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return []
  const record = data as Record<string, unknown>

  const metaById = new Map<string, Record<string, unknown>>()
  if (Array.isArray(record.models)) {
    for (const model of record.models as unknown[]) {
      if (typeof model !== 'object' || model === null) continue
      const entry = model as Record<string, unknown>
      if (typeof entry.id === 'string') metaById.set(entry.id, entry)
    }
  }

  const promotions = parsePromotions(record)
  const agentRefIds = new Set<string>()
  if (Array.isArray(record.agents)) {
    for (const agent of record.agents as unknown[]) {
      if (typeof agent !== 'object' || agent === null) continue
      const models = (agent as Record<string, unknown>).models
      if (!Array.isArray(models)) continue
      for (const model of models) if (typeof model === 'string') agentRefIds.add(model)
    }
  }

  const parsed: RemoteModel[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (isAutoSelectAlias(id) || seen.has(id) || !isChatModel(id, metaById.get(id))) return
    seen.add(id)
    const meta = metaById.get(id)
    const remoteName = typeof meta?.name === 'string' && meta.name.length > 0 ? meta.name : undefined
    parsed.push({
      id,
      name: remoteName ?? MODEL_DISPLAY_NAMES[id] ?? id,
      ...parseModelMeta(meta),
    })
  }

  for (const agentName of PREFERRED_AGENT_NAMES) {
    const agents = record.agents
    if (!Array.isArray(agents)) break
    let found = false
    for (const agent of agents) {
      if (typeof agent !== 'object' || agent === null) continue
      const agentRecord = agent as Record<string, unknown>
      if (agentRecord.name !== agentName) continue
      if (Array.isArray(agentRecord.models)) {
        for (const model of agentRecord.models) if (typeof model === 'string') push(model)
      }
      found = true
      break
    }
    if (found) break
  }

  for (const id of metaById.keys()) push(id)

  for (const id of trialModelIds(record)) {
    if (isAutoSelectAlias(id) || seen.has(id)) continue
    seen.add(id)
    const meta = metaById.get(id)
    const remoteName = typeof meta?.name === 'string' && meta.name.length > 0 ? meta.name : undefined
    parsed.push({ id, name: remoteName ?? MODEL_DISPLAY_NAMES[id] ?? id, ...parseModelMeta(meta) })
  }

  return parsed
}

export function mergeRemoteModels(primary: RemoteModel[], extra: RemoteModel[]): RemoteModel[] {
  const known = new Set(primary.map((m) => m.id))
  return [...primary, ...extra.filter((m) => !known.has(m.id))]
}

/** Normalize a RemoteModel into a protocol ProtocolModelInfo (with capabilities). */
export function toModelDescriptor(model: RemoteModel): ProtocolModelInfo {
  const caps: ProtocolModelInfo['capabilities'] = {
    vision: model.supportsImages ?? false,
    toolCall: true,
    streaming: true,
  }
  const efforts = model.reasoningEfforts
  if (efforts && efforts.length > 0) caps.reasoningEfforts = efforts
  return { id: model.id, name: model.name, capabilities: caps }
}

/** Build a fallback catalog from static tables (used when live discovery fails). */
export function fallbackModels(): ProtocolModelInfo[] {
  return FALLBACK_MODELS.map((m) => {
    const caps: ProtocolModelInfo['capabilities'] = {
      vision: m.capabilities.vision,
      toolCall: m.capabilities.toolCall,
      streaming: m.capabilities.streaming,
    }
    const efforts = m.capabilities.reasoningEfforts
    if (efforts && efforts.length > 0) caps.reasoningEfforts = [...efforts]
    return { id: m.id, name: m.name, capabilities: caps }
  })
}

export function defaultModelId(): string {
  return DEFAULT_MODEL
}

export function normalizeRate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const head = value.trim().split(/\s+/)[0] ?? ''
  const m = /^(?:x(\d+(?:\.\d+)?))\b/i.exec(head) ?? /^(\d+(?:\.\d+)?)x\b/i.exec(head)
  return m?.[1] !== undefined ? `x${m[1]}` : undefined
}

/** Round a credit value to two decimals (avoids float noise from summation). */
export function roundCredits(value: number): number {
  return Math.round(value * 100) / 100
}