/**
 * Default mapping from raw failures (fetch errors, HTTP responses, aborts) to
 * UpstreamError. Provider adapters may register extra business-code mappings
 * on top; Core only ever consumes the normalized kinds.
 */
import { UpstreamError, type UpstreamErrorKind } from './upstream-error.js'

export interface ErrorSourceContext {
  provider: string
  /** upstream model, attached to RATE_LIMIT details for per-model cooldowns */
  model?: string
}

export interface RawHttpFailure {
  type: 'http'
  status: number
  /** Retry-After header (seconds) when present */
  retryAfterSeconds?: number
  /** body snippet for detail (must be pre-sanitized: no secrets) */
  bodySnippet?: string
}

export interface RawNetworkFailure {
  type: 'network'
  /** e.g. ENOTFOUND, ECONNREFUSED, ECONNRESET, ETIMEDOUT */
  code?: string
  message: string
}

export type RawFailure = RawHttpFailure | RawNetworkFailure

/** Provider-specific business code → kind (e.g. 81111 queue, 1005/1113 quota). */
export type BusinessCodeMap = (businessCode: string, ctx: ErrorSourceContext) => UpstreamErrorKind | undefined

const providerBusinessCodes = new Map<string, BusinessCodeMap>()

/** Register provider-specific business-code mapping (called by adapters). */
export function registerBusinessCodes(provider: string, map: BusinessCodeMap): void {
  providerBusinessCodes.set(provider, map)
}

export function unregisterBusinessCodes(provider: string): void {
  providerBusinessCodes.delete(provider)
}

function kindForHttp(status: number): UpstreamErrorKind {
  if (status === 401 || status === 403) return 'AUTH_INVALID'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'UPSTREAM_5XX'
  return 'TERMINAL'
}

const TRANSPORT_CODES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
])

export function normalizeFailure(raw: RawFailure, ctx: ErrorSourceContext): UpstreamError {
  if (raw.type === 'network') {
    const kind: UpstreamErrorKind =
      raw.code === 'ETIMEDOUT' ? 'TIMEOUT' : TRANSPORT_CODES.has(raw.code ?? '') ? 'TRANSPORT' : 'TRANSPORT'
    return new UpstreamError({
      kind,
      message: raw.message || `network failure (${raw.code ?? 'unknown'})`,
      provider: ctx.provider,
      detail: raw.code,
      cause: raw,
    })
  }

  // HTTP failure
  let kind = kindForHttp(raw.status)
  let retryAfterMs: number | undefined

  // provider-specific business code refinement takes precedence
  const businessCode = extractBusinessCode(raw.bodySnippet)
  if (businessCode) {
    const mapped = providerBusinessCodes.get(ctx.provider)?.(businessCode, ctx)
    if (mapped) kind = mapped
  }

  if (kind === 'RATE_LIMIT') {
    retryAfterMs =
      raw.retryAfterSeconds !== undefined
        ? raw.retryAfterSeconds * 1000
        : undefined
  }

  return new UpstreamError({
    kind,
    message: `upstream ${raw.status}${businessCode ? ` (code ${businessCode})` : ''}`,
    status: raw.status,
    provider: ctx.provider,
    retryAfterMs,
    detail: ctx.model ? `model:${ctx.model}` : raw.bodySnippet?.slice(0, 200),
    cause: raw,
  })
}

/** Wrap an unknown thrown value; UpstreamErrors pass through untouched. */
export function normalizeThrown(err: unknown, ctx: ErrorSourceContext): UpstreamError {
  if (err instanceof UpstreamError) return err
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return new UpstreamError({
        kind: 'TIMEOUT',
        message: err.message || 'request aborted/timeout',
        provider: ctx.provider,
        cause: err,
      })
    }
    const code = (err as NodeJS.ErrnoException).code
    return normalizeFailure({ type: 'network', code, message: err.message }, ctx)
  }
  return new UpstreamError({
    kind: 'TERMINAL',
    message: String(err),
    provider: ctx.provider,
    cause: err,
  })
}

/**
 * Extract a business code from a response body snippet. Providers embed codes
 * in various shapes: `{"code":1005,...}` or `"code":"81111"`. Returns the first
 * plausible numeric/string code, or undefined.
 */
export function extractBusinessCode(bodySnippet: string | undefined): string | undefined {
  if (!bodySnippet) return undefined
  const match = bodySnippet.match(/"code"\s*:\s*"?([A-Za-z0-9_.-]+)"?/)
  return match?.[1]
}

/** Map a normalized error to an outbound OpenAI-style HTTP status. */
export function toOpenAiStatus(error: UpstreamError): number {
  switch (error.kind) {
    case 'AUTH_INVALID':
    case 'TOKEN_EXPIRED':
      return 502 // upstream auth problem is not the client's fault
    case 'RATE_LIMIT':
      return 429
    case 'QUOTA_EXHAUSTED':
      return 503
    case 'NEEDS_CAPTCHA':
    case 'NEEDS_MANUAL':
      return 503
    case 'TERMINAL':
      return 400
    default:
      return 502 // TIMEOUT / TRANSPORT / UPSTREAM_5XX / EMPTY_RESPONSE
  }
}

/** OpenAI error response body. Never includes upstream internals/secrets. */
export function toOpenAiErrorBody(error: UpstreamError): Record<string, unknown> {
  const typeByKind: Record<string, string> = {
    AUTH_INVALID: 'upstream_auth_error',
    TOKEN_EXPIRED: 'upstream_auth_error',
    RATE_LIMIT: 'rate_limit_error',
    QUOTA_EXHAUSTED: 'insufficient_quota',
    TIMEOUT: 'timeout',
    TRANSPORT: 'upstream_error',
    UPSTREAM_5XX: 'upstream_error',
    TERMINAL: 'invalid_request_error',
    EMPTY_RESPONSE: 'upstream_error',
    NEEDS_CAPTCHA: 'manual_action_required',
    NEEDS_MANUAL: 'manual_action_required',
  }
  return {
    error: {
      message: error.message,
      type: typeByKind[error.kind] ?? 'upstream_error',
      code: error.kind.toLowerCase(),
    },
  }
}
