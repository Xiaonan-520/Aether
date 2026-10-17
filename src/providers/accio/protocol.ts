/**
 * Accio (Alibaba Accio Work) protocol layer.
 *
 * Upstream speaks a **Gemini-style** envelope with snake_case keys over
 * `POST {gateway}/api/adk/llm/generateContent?sg_k=<md5(requestId)>`:
 *
 *   - token goes in the BODY (`token` field) — putting it in the Authorization
 *     header is rejected in-stream with 402
 *   - `system_instruction` is a STRING, not `{parts:[{text}]}` (upstream does
 *     `String(...)` on it; sending the object yields HTTP 200 + in-stream 400)
 *   - `empid` / `tenant` / `iai_tag` must be EMPTY strings
 *   - `message_id` is REQUIRED (md5 of requestId + random salt)
 *   - tool schemas must stay JSON-STRINGIFIED (`parameters_json`) — passing
 *     objects lets the recursive camel→snake rewrite silently rename schema keys
 *   - the `properties` subtree is NOT camel→snake converted (appKey stays
 *     camelCase, normalized_response stays snake_case)
 *   - tools can be omitted entirely (upstream returns 200 with no tool_calls)
 *
 * The model catalog is fetched from the gateway; the fallback list is only an
 * offline safety net. Login region (cn / global) selects the LOGIN page host —
 * the LLM gateway host is the same for both.
 *
 * Reference: iJetLi/dsh-providers-hub src/accio-*.ts (MIT).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

export type AccioRegion = 'cn' | 'global'

export interface AccioProduct {
  id: string
  displayName: string
  gatewayBaseUrl: string
  loginBaseUrlOf: (region: AccioRegion) => string
  clientId: string
  appKey: string
  appVersion: string
  fallbackModels: ReadonlyArray<{ id: string; name: string; contextWindow: number; supportsImage: boolean; multiple: number }>
}

export const ACCIO_LLM_PATH = '/api/adk/llm/generateContent'
export const ACCIO_TOKEN_EXCHANGE_PATH = '/api/oauth/token'
export const ACCIO_REFRESH_PATH = '/api/auth/refresh_token'
export const ACCIO_USERINFO_PATH = '/api/userinfo'

const LOGIN_BASE: Record<AccioRegion, string> = {
  cn: 'https://www.accio-ai.com',
  global: 'https://zh.accio.com',
}

export const ACCIO: AccioProduct = {
  id: 'accio',
  displayName: 'Accio (阿里)',
  gatewayBaseUrl: 'https://phoenix-gw.alibaba.com',
  loginBaseUrlOf: (region) => LOGIN_BASE[region] ?? LOGIN_BASE.cn,
  clientId: 'accio-work',
  appKey: 'OneChat',
  appVersion: '0.34.4',
  fallbackModels: Object.freeze([
    { id: '1Drift-N8kP2Q7wR5mX', name: 'Qwen 3.8 27B', contextWindow: 512_000, supportsImage: true, multiple: 0.013 },
    { id: '1Drift-F8hS3mK7pL2n', name: 'Qwen 3.8 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
    { id: '1Chronos-F53X9nQ3rT8w', name: 'GLM 5.3 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
    { id: '1Nova-Q3xM8vJ1rH6z', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.045 },
    { id: '1Zenith-M27hS2SR5xQ2p', name: 'MiniMax M3', contextWindow: 1_000_000, supportsImage: true, multiple: 0.08 },
    { id: '1Nexus-R3wF8qJ5vB6h', name: 'Standard', contextWindow: 1_000_000, supportsImage: true, multiple: 0.13 },
    { id: '1Synapse-G5aJ8wL1dV4s', name: 'Kimi K2.6', contextWindow: 256_000, supportsImage: true, multiple: 0.14 },
    { id: '1Nova-bW7yT4kL9pN2', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, supportsImage: false, multiple: 0.17 },
    { id: '1Drift-T3TB6WS9a23w', name: 'Qwen 3.8 Max', contextWindow: 1_000_000, supportsImage: true, multiple: 0.44 },
  ]),
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

export interface AccioCredential {
  access_token: string
  refresh_token?: string
  /** the region the account logged in through — drives the login host only */
  region: AccioRegion
  expires_at?: number
  /** opaque 32-char upstream id; used as the provider-side account identity */
  display_name?: string
}

export function isAccioRefreshable(c: AccioCredential): boolean {
  return typeof c.refresh_token === 'string' && c.refresh_token !== ''
}

export function credentialExpiresAtMs(c: AccioCredential): number | undefined {
  return typeof c.expires_at === 'number' ? c.expires_at : undefined
}

export function isExpired(c: AccioCredential, now = Date.now()): boolean {
  const at = credentialExpiresAtMs(c)
  return at !== undefined && now >= at - 30_000
}

/** One request id — reused for `sg_k` and `message_id` derivation. */
export function accioRequestId(): string {
  return `req-${Date.now()}-${randomUUID().slice(0, 8)}`
}

/** `sg_k` = md5(requestId) hex. */
export function accioSgK(requestId: string): string {
  return createHash('md5').update(requestId, 'utf8').digest('hex')
}

/**
 * `message_id` — REQUIRED (upstream 400s without it). Salted so two calls with
 * the same requestId differ.
 */
export function accioMessageId(requestId: string): string {
  return createHash('md5').update(`${requestId}:${randomBytes(16).toString('hex')}`, 'utf8').digest('hex')
}

/** camelCase → snake_case, recursively. `undefined` keys are dropped entirely. */
export function accioToSnake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => accioToSnake(v))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = accioToSnake(v)
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

export type AccioOpenAiMessage = {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
}

export interface BuildAccioBodyOptions {
  model: string
  accessToken: string
  messages: AccioOpenAiMessage[]
  tools?: readonly unknown[]
  temperature?: number
  maxOutputTokens?: number
  utdid: string
  requestId: string
}

export interface AccioTool {
  name: string
  description?: string
  /** JSON-STRINGIFIED schema (never an object — see module doc) */
  parameters_json: string
}

/**
 * OpenAI tool shape → Accio tool shape. Canonical `{name,…}` and OpenAI
 * `{type:'function',function:{…}}` are both accepted.
 */
export function toAccioTools(tools: ReadonlyArray<unknown> | undefined): AccioTool[] {
  return (tools ?? []).map((raw) => {
    const t = raw as Record<string, unknown>
    const fn = (t.function && typeof t.function === 'object' ? t.function : t) as Record<string, unknown>
    const schema = fn.parameters
    return {
      name: String(fn.name ?? ''),
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters_json: JSON.stringify(schema ?? { type: 'object', properties: {} }),
    }
  })
}

/** Flatten OpenAI messages into Accio `contents` + `systemInstruction`. */
export function buildAccioContents(
  messages: AccioOpenAiMessage[],
): { contents: unknown[]; systemInstruction: string } {
  let systemInstruction = ''
  const parts: string[] = []
  const contents: unknown[] = []

  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      if (typeof m.content === 'string' && m.content !== '') parts.push(m.content)
      continue
    }
    if (m.role === 'tool') {
      // Accio models the tool result as a functionResponse part on a user turn
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.tool_call_id ?? 'tool', response: { result: m.content ?? '' } } }],
      })
      continue
    }
    if (m.role === 'assistant') {
      const blocks: unknown[] = []
      if (typeof m.content === 'string' && m.content !== '') blocks.push({ text: m.content })
      for (const tc of m.tool_calls ?? []) {
        let args: unknown = {}
        try {
          args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          args = {} // never fabricate
        }
        blocks.push({ functionCall: { name: tc.function?.name ?? '', args } })
      }
      if (blocks.length === 0) continue
      contents.push({ role: 'model', parts: blocks })
      continue
    }
    // user
    if (typeof m.content === 'string' && m.content !== '') {
      contents.push({ role: 'user', parts: [{ text: m.content }] })
    }
  }
  systemInstruction = parts.join('\n\n')
  return { contents, systemInstruction }
}

/** Build the full request body (already snake_case). */
export function buildAccioBody(opts: BuildAccioBodyOptions): Record<string, unknown> {
  const { contents, systemInstruction } = buildAccioContents(opts.messages)
  const camel = {
    model: opts.model,
    empid: '',
    tenant: '',
    iaiTag: '',
    requestId: opts.requestId,
    userRequestId: opts.requestId,
    contents,
    // ⚠️ string, never {parts:[…]} — see module doc point 4
    systemInstruction: systemInstruction === '' ? undefined : systemInstruction,
    tools: toAccioTools(opts.tools as readonly unknown[] | undefined),
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
    stopSequences: [],
    properties: {
      utdid: opts.utdid,
      version: ACCIO.appVersion,
      appKey: ACCIO.appKey,
      normalizedResponse: 'true',
    },
    token: opts.accessToken,
    messageId: accioMessageId(opts.requestId),
    incremental: true,
  }
  const body = accioToSnake(camel) as Record<string, unknown>
  // the properties subtree does NOT participate in camel→snake conversion
  body.properties = {
    utdid: opts.utdid,
    version: ACCIO.appVersion,
    appKey: ACCIO.appKey,
    normalized_response: 'true',
  }
  return body
}

/** Request headers. Deliberately NO SecurityGuard `pctb-x-*` (verified live). */
export function accioHeaders(utdid: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    utdid,
    version: ACCIO.appVersion,
    appKey: ACCIO.appKey,
  }
}

// ---------------------------------------------------------------------------
// SSE → canonical chunks
// ---------------------------------------------------------------------------

export interface AccioChunk {
  text: string
  reasoning?: string
  finishReason?: 'stop' | 'length' | 'tool_calls' | null
  usage?: { promptTokens?: number; completionTokens?: number }
  toolCalls?: Array<{ id?: string; name?: string; arguments?: string; index?: number }>
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * Parse one `data:` payload from the Accio SSE stream into canonical chunks.
 *
 * Events are Gemini-shaped lines with either `content.parts[]` (text /
 * functionCall / thought markers) or an `error_code` field. `thought: true`
 * parts are reasoning, not content.
 */
export function parseAccioEvent(raw: string): AccioChunk[] {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return []
  }

  // in-stream error (HTTP stays 200)
  const errorCode = num(data.error_code)
  if (errorCode !== undefined) {
    const e = new Error(String(data.error_message ?? `accio stream error ${errorCode}`)) as Error & { upKind?: string }
    e.upKind = errorCode === 402 || errorCode === 401 ? 'AUTH_INVALID' : errorCode >= 500 ? 'UPSTREAM_5XX' : 'TERMINAL'
    throw e
  }

  const content = data.content as Record<string, unknown> | undefined
  if (!content) return []
  const parts = Array.isArray(content.parts) ? content.parts as Array<Record<string, unknown>> : []

  const out: AccioChunk[] = []
  let text = ''
  const toolCalls: NonNullable<AccioChunk['toolCalls']> = []
  let reasoning = ''
  for (const part of parts) {
    if (part.thought === true && typeof part.text === 'string' && part.text.length > 0) {
      reasoning += part.text
      continue
    }
    if (typeof part.text === 'string' && part.text.length > 0) {
      text += part.text
      continue
    }
    const call = part.functionCall as Record<string, unknown> | undefined
    if (call && typeof call.name === 'string') {
      toolCalls.push({
        id: `call_${createHash('md5').update(raw + toolCalls.length).digest('hex').slice(0, 24)}`,
        name: call.name,
        arguments: JSON.stringify(call.args ?? {}),
        index: toolCalls.length,
      })
    }
  }
  if (text !== '') out.push({ text })
  if (reasoning !== '') out.push({ text: '', reasoning })

  const finishReasonRaw = data.finish_reason ?? data.finishReason
  if (toolCalls.length > 0) {
    out.push({ text: '', toolCalls, finishReason: 'tool_calls' })
  } else if (typeof finishReasonRaw === 'string' && finishReasonRaw !== '') {
    const mapped = finishReasonRaw === 'max-tokens' || finishReasonRaw === 'max_tokens' ? 'length' : 'stop'
    out.push({ text: '', finishReason: mapped as 'stop' | 'length' })
  }

  // usage
  const usageMeta = data.usage_metadata as Record<string, unknown> | undefined
    ?? data.usageMetadata as Record<string, unknown> | undefined
  if (usageMeta) {
    const prompt = num(usageMeta.prompt_token_count) ?? num(usageMeta.promptTokenCount)
    const candidates = num(usageMeta.candidates_token_count) ?? num(usageMeta.candidatesTokenCount)
    if (prompt !== undefined || candidates !== undefined) {
      const last = out.length > 0 ? out[out.length - 1]! : { text: '' }
      last.usage = {
        ...(prompt !== undefined ? { promptTokens: prompt } : {}),
        ...(candidates !== undefined ? { completionTokens: candidates } : {}),
      }
      if (out.length === 0) out.push(last)
    }
  }
  return out
}
