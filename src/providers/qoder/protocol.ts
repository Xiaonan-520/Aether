/**
 * Qoder protocol primitives: credential, device-code login, refresh, model
 * catalog and the `/sash/` usage + campaign endpoints.
 *
 * Verified reference (jet-hub src/qoder.ts / qoder-product.ts).
 * The encrypted inference path lives in wasm.ts + provider.ts.
 */
import { randomUUID } from 'node:crypto'
import type { QoderProduct } from './product.js'

export type Fetcher = typeof fetch

/** Persisted Qoder credential. `machine_id` MUST be persisted (device binding). */
export interface QoderCredential {
  access_token: string
  /** the WASM consumes this as `securityOauthToken` (same value as access_token) */
  security_oauth_token?: string
  /** also written as `security_oauth_token` (same value) */
  refresh_token: string
  expires_at?: string
  uid?: string
  nickname?: string
  /** account-scoped device identity, required by refresh and the WASM */
  machine_id: string
  organization_id?: string
}

/** Generate a fresh account-scoped machine id (persisted for the account's life). */
export function newQoderMachineId(): string {
  return randomUUID()
}

export function isQoderRefreshable(credential: QoderCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
}

export function qoderCredentialExpiresAtMs(credential: QoderCredential): number | undefined {
  const raw = credential.expires_at
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (Number.isFinite(value)) return value > 1_000_000_000_000 ? value : value * 1000
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Refresh body: `{refresh_token, machine_id}` (machine_id is mandatory). */
export function qoderRefreshBody(credential: QoderCredential): Record<string, unknown> {
  return { refresh_token: credential.refresh_token, machine_id: credential.machine_id }
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

export interface QoderTokenPayload {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  uid?: string
  nickname?: string
  organizationId?: string
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  if (typeof value === 'string' && value !== '') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) return asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

/** Parse a device-token / refresh response into a token payload. */
export function parseQoderTokenPayload(body: unknown): QoderTokenPayload | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const root = body as Record<string, unknown>
  const inner = typeof root.data === 'object' && root.data !== null ? (root.data as Record<string, unknown>) : root
  const accessToken = readString(inner, ['access_token', 'accessToken'])
  if (!accessToken) return undefined
  const user = typeof inner.user === 'object' && inner.user !== null ? (inner.user as Record<string, unknown>) : {}
  return {
    accessToken,
    refreshToken: readString(inner, ['refresh_token', 'refreshToken', 'security_oauth_token']),
    expiresAt: parseTimestamp(inner.expires_at ?? inner.expiresAt ?? inner.expire_time),
    uid: readString(inner, ['user_id', 'userId', 'uid']) ?? readString(user, ['id', 'uid']),
    nickname: readString(inner, ['nickname', 'name']) ?? readString(user, ['nickname', 'name', 'display_name']),
    organizationId: readString(inner, ['organization_id', 'organizationId']),
  }
}

/** Merge a token payload into a credential, preserving the machine id. */
export function buildQoderCredential(
  payload: QoderTokenPayload,
  base: Partial<QoderCredential>,
): QoderCredential {
  const expiresAt = payload.expiresAt ?? (base.expires_at ? Number(base.expires_at) : undefined)
  return {
    access_token: payload.accessToken,
    // reference writes security_oauth_token and access_token with the same value
    security_oauth_token: base.security_oauth_token ?? payload.accessToken,
    refresh_token: payload.refreshToken ?? base.refresh_token ?? '',
    ...(expiresAt ? { expires_at: String(expiresAt) } : {}),
    ...(payload.uid ?? base.uid ? { uid: payload.uid ?? base.uid } : {}),
    ...(payload.nickname ?? base.nickname ? { nickname: payload.nickname ?? base.nickname } : {}),
    ...(payload.organizationId ?? base.organization_id
      ? { organization_id: payload.organizationId ?? base.organization_id }
      : {}),
    machine_id: base.machine_id ?? newQoderMachineId(),
  }
}

/** Common Cosy headers. */
export function qoderHeaders(credential: QoderCredential | undefined, product: QoderProduct): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Cosy-ClientType': String(product.clientType),
    'Cosy-Version': product.clientVersion,
    'User-Agent': `${product.userAgentPrefix}/${product.clientVersion}`,
    ...(credential?.access_token ? { Authorization: `Bearer ${credential.access_token}` } : {}),
  }
}

export interface QoderModel {
  id: string
  name: string
}

/**
 * Parse the model catalog. The real catalog is encrypted and requires the WASM
 * to decrypt; this parses the plain shape and otherwise returns nothing so the
 * caller falls back to the product table (never inventing entries).
 */
export function parseQoderModels(body: unknown): QoderModel[] {
  if (typeof body !== 'object' || body === null) return []
  const root = body as Record<string, unknown>
  const list = Array.isArray(root.models)
    ? root.models
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray((root.data as Record<string, unknown> | undefined)?.models)
        ? ((root.data as Record<string, unknown>).models as unknown[])
        : []
  const models: QoderModel[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = readString(record, ['id', 'key', 'model'])
    if (!id) continue
    models.push({ id, name: readString(record, ['name', 'display_name', 'displayName']) ?? id })
  }
  return models
}

export interface QoderCampaign {
  campaignId: string
  claimable: boolean
}

/** Parse `/sash/api/v1/me/campaigns`. */
export function parseQoderCampaigns(body: unknown): QoderCampaign[] {
  if (typeof body !== 'object' || body === null) return []
  const root = body as Record<string, unknown>
  const inner = typeof root.data === 'object' && root.data !== null ? (root.data as Record<string, unknown>) : root
  const list = Array.isArray(inner.campaigns) ? inner.campaigns : Array.isArray(inner) ? (inner as unknown[]) : []
  const out: QoderCampaign[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = readString(record, ['campaignId', 'id', 'campaign_id'])
    if (!id) continue
    out.push({
      campaignId: id,
      claimable: record.claimable === true || record.status === 'CLAIMABLE' || record.state === 'CLAIMABLE',
    })
  }
  return out
}

/** Parse `/sash/api/v2/me/usage` into a remaining/total pair. */
export function parseQoderUsage(body: unknown): { remaining: number | null; total: number | null } {
  if (typeof body !== 'object' || body === null) return { remaining: null, total: null }
  const root = body as Record<string, unknown>
  const inner = typeof root.data === 'object' && root.data !== null ? (root.data as Record<string, unknown>) : root
  const pick = (keys: string[]): number | null => {
    for (const key of keys) {
      const value = inner[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return null
  }
  return {
    remaining: pick(['remaining', 'balance', 'credits_remaining', 'available']),
    total: pick(['total', 'credits_amount', 'quota']),
  }
}
