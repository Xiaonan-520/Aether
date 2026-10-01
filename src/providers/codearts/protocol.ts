/**
 * CodeArts protocol primitives: credential shape, token exchange, model list
 * parsing and header construction.
 *
 * Chat is OpenAI-compatible SSE against `{chatBase}/chat/completions`, signed
 * with SDK-HMAC-SHA256 (see sign.ts). The temporary AK/SK come from the
 * credential (obtained at login via a signed ticket exchange).
 */
import type { CodeArtsProduct } from './product.js'

export type Fetcher = typeof fetch

/** Persisted CodeArts credential (temporary AK/SK from the IoTDA-style STS). */
export interface CodeArtsCredential {
  access_key_id: string
  secret_access_key: string
  security_token: string
  expires_at?: string
  domain_id?: string
  user_id?: string
  user_name?: string
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Parse the credential-ticket response, accepting both the nested
 * (`credential` / `result`) and flat shapes seen in the reference.
 */
export function parseCodeArtsCredential(body: unknown): CodeArtsCredential | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const root = body as Record<string, unknown>
  const nested =
    typeof root.credential === 'object' && root.credential !== null
      ? (root.credential as Record<string, unknown>)
      : typeof root.result === 'object' && root.result !== null
        ? (root.result as Record<string, unknown>)
        : root
  const accessKeyId = readString(nested, ['access', 'accessKeyId', 'access_key_id', 'accessKeyID'])
  const secretAccessKey = readString(nested, ['secret', 'secretAccessKey', 'secret_access_key'])
  const securityToken = readString(nested, ['securitytoken', 'securityToken', 'security_token'])
  if (!accessKeyId || !secretAccessKey || !securityToken) return undefined
  const expiresAt = readString(nested, ['expires_at', 'expiresAt', 'expiration'])
  return {
    access_key_id: accessKeyId,
    secret_access_key: secretAccessKey,
    security_token: securityToken,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(readString(root, ['domain_id', 'domainId']) ? { domain_id: readString(root, ['domain_id', 'domainId']) } : {}),
    ...(readString(root, ['user_id', 'userId']) ? { user_id: readString(root, ['user_id', 'userId']) } : {}),
    ...(readString(root, ['user_name', 'userName']) ? { user_name: readString(root, ['user_name', 'userName']) } : {}),
  }
}

export function isCodeArtsExpired(credential: CodeArtsCredential): boolean {
  const raw = credential.expires_at
  if (!raw) return false
  const value = Number(raw)
  const ms = Number.isFinite(value) ? (value > 1_000_000_000_000 ? value : value * 1000) : Date.parse(raw)
  if (Number.isNaN(ms)) return false
  return Date.now() >= ms
}

/**
 * CodeArts has no refresh endpoint: the credential is a temporary AK/SK that
 * must be re-obtained by logging in again (`expired -> re-login required`).
 */
export function isCodeArtsRefreshable(): boolean {
  return false
}

export interface CodeArtsModel {
  id: string
  name: string
}

/**
 * Parse `GET /v1/model/builtin`. Accepts `{data:[…]}` / `{models:[…]}` /
 * `{result:[…]}` and a bare array; entries are `{id|model, name|display_name}`.
 * Benefit models need the `maas_type: benefit` extra signed header.
 */
export function parseCodeArtsModels(body: unknown): CodeArtsModel[] {
  if (typeof body !== 'object' || body === null) return []
  const root = body as Record<string, unknown>
  const list = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : Array.isArray(root.result)
        ? root.result
        : Array.isArray(root)
          ? (root as unknown[])
          : []
  const models: CodeArtsModel[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    const id = readString(r, ['id', 'model', 'modelId', 'model_id'])
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({ id, name: readString(r, ['name', 'display_name', 'displayName']) ?? id })
  }
  return models
}

/** Models that require the `maas_type: benefit` extra signed header. */
export function isCodeArtsBenefitModel(model: string): boolean {
  return /-07\d{2}$|-08\d{2}$/.test(model) || /^deepseek-v4-(flash|pro)$/.test(model)
}

/** Build a plain (unsigned) header set for the chat endpoint. */
export function codeArtsChatHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...extra,
  }
}

export { type CodeArtsProduct }
