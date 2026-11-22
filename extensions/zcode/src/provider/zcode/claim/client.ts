/**
 * HTTP client for ZCode's manual-claim billing endpoints (weekend plans).
 *
 * Ported from TriDefender/zcode-api (`src/claim/client.ts`, CC BY-NC-SA 4.0 —
 * see THIRD-PARTY-NOTICES.md). Two enumeration faces plus one claim call:
 *
 *   - `GET  {origin}/api/v1/zcode-plan/billing/preview?app_version=&platform=`
 *     headers: `Authorization: Bearer {jwt}` only
 *   - `GET  {origin}/api/v1/marketing/touch?seq=N` — banner-distributed plans
 *     (requires a UUID `X-Device-Mid`; failures are treated as "no plans")
 *   - `POST {origin}/api/v1/zcode-plan/billing/claim` body `{plan_id}`
 *     headers: Authorization, Content-Type, [captcha param, [captcha region]],
 *     X-ZCode-App-Version, X-Platform, [X-Device-Mid]
 *
 * `X-Device-Mid` is a campaign-gated gateway requirement: preview/claim answer
 * biz 3001 "parameter error" without it during some campaigns, so it is sent
 * whenever the caller can supply a stable UUID.
 */
import {
  ClaimPreviewError,
  classifyClaimCode,
  type ClaimOutcome,
  type ClaimablePlan,
  type PlanEntitlement,
} from './types.js'

export interface ClaimClientOptions {
  origin: string
  /** OAuth JWT (`zcodejwttoken`); preview works without it, claim does not. */
  jwt?: string
  appVersion: string
  /** `${platform}-${arch}` in the real client. */
  platform: string
  /** Campaign-gated gateway requirement (UUID). */
  deviceMid?: string
  /** Locale header for the marketing face. Default `zh-CN`. */
  language?: string
  /** Per-call timeout in ms. Default 15s (bundle `ss`). */
  timeoutMs?: number
  /** DI seam for tests. */
  fetchImpl?: typeof fetch
}

export interface ClaimClient {
  getPreviews(signal?: AbortSignal): Promise<ClaimablePlan[]>
  getMarketingPlans(signal?: AbortSignal): Promise<ClaimablePlan[]>
  /** Preview + banner merged, deduped by planId (preview wins). */
  listPlans(signal?: AbortSignal): Promise<ClaimablePlan[]>
  claim(
    planId: string,
    captcha?: { verifyParam: string; region?: string },
    signal?: AbortSignal,
  ): Promise<ClaimOutcome>
}

const DEFAULT_TIMEOUT_MS = 15_000

interface RawEntitlement {
  entitlement_id?: string
  show_name?: string
  meter?: string
  unit_type?: string
  capabilities?: string[]
  grant_units?: number
  period?: string
  priority?: number
  effective_at?: number
}

interface RawPlan {
  plan_id?: string
  name?: string
  description?: string
  priority?: number
  entitlements?: RawEntitlement[]
  starts_at?: number
  ends_at?: number
}

function parseEntitlement(raw: RawEntitlement): PlanEntitlement | null {
  const entitlementId = raw.entitlement_id?.trim() ?? ''
  if (!entitlementId) return null
  const entitlement: PlanEntitlement = {
    entitlementId,
    showName: raw.show_name?.trim() ?? '',
    meter: raw.meter?.trim() ?? '',
    unitType: raw.unit_type?.trim() ?? '',
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : [],
    grantUnits: Number.isFinite(raw.grant_units) ? (raw.grant_units as number) : 0,
    period: raw.period?.trim() ?? '',
    priority: Number.isFinite(raw.priority) ? (raw.priority as number) : 0,
  }
  if (Number.isFinite(raw.effective_at)) entitlement.effectiveAt = raw.effective_at as number
  return entitlement
}

function parsePlan(raw: RawPlan): ClaimablePlan | null {
  const planId = raw.plan_id?.trim() ?? ''
  if (!planId) return null
  const plan: ClaimablePlan = {
    planId,
    name: raw.name?.trim() || planId,
    description: raw.description?.trim() ?? '',
    priority: Number.isFinite(raw.priority) ? (raw.priority as number) : 0,
    entitlements: (raw.entitlements ?? []).flatMap((ent) => {
      const parsed = parseEntitlement(ent)
      return parsed ? [parsed] : []
    }),
  }
  if (Number.isFinite(raw.starts_at)) plan.startsAt = raw.starts_at as number
  if (Number.isFinite(raw.ends_at)) plan.endsAt = raw.ends_at as number
  return plan
}

interface MarketingNode {
  action?: { type?: unknown; args?: { plan_id?: unknown } }
  buttons?: MarketingNode[]
}
interface MarketingDelivery {
  campaign_id?: unknown
  banner?: MarketingNode & { background?: { args?: Record<string, unknown> } }
  popup?: MarketingNode & { background?: { args?: Record<string, unknown> } }
}

/** Collect `zcode_plan` objects anywhere inside a delivery (depth-limited). */
function collectZcodePlans(node: unknown, out: RawPlan[], depth = 0): void {
  if (depth > 4 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectZcodePlans(item, out, depth + 1)
    return
  }
  const record = node as Record<string, unknown>
  const plan = record.zcode_plan
  if (plan && typeof plan === 'object' && !Array.isArray(plan)) out.push(plan as RawPlan)
  for (const value of Object.values(record)) collectZcodePlans(value, out, depth + 1)
}

/**
 * deliveries → claimable plans: the button action `claim_zcode_plan` supplies
 * the plan_id, the banner background args carry the full `zcode_plan` object.
 */
function parseMarketingDeliveries(deliveries: unknown[]): ClaimablePlan[] {
  const plans: ClaimablePlan[] = []
  const seen = new Set<string>()
  for (const entry of deliveries) {
    if (entry === null || typeof entry !== 'object') continue
    const delivery = entry as MarketingDelivery
    const campaignId = typeof delivery.campaign_id === 'string' ? delivery.campaign_id : undefined
    const richPlans: RawPlan[] = []
    collectZcodePlans(delivery, richPlans)
    const richById = new Map(richPlans.map((plan) => [plan.plan_id?.trim() ?? '', plan]))
    for (const host of [delivery.banner, delivery.popup]) {
      for (const button of host?.buttons ?? []) {
        if (button?.action?.type !== 'claim_zcode_plan') continue
        const planId = typeof button.action.args?.plan_id === 'string' ? button.action.args.plan_id.trim() : ''
        if (!planId || seen.has(planId)) continue
        const raw = richById.get(planId) ?? { plan_id: planId }
        const plan = parsePlan(raw)
        if (!plan) continue
        seen.add(planId)
        plan.source = 'banner'
        if (campaignId) plan.campaignId = campaignId
        plans.push(plan)
      }
    }
  }
  return plans
}

const ZCODE_ORIGIN = 'https://zcode.z.ai'

export function createClaimClient(options: ClaimClientOptions): ClaimClient {
  const origin = (options.origin || ZCODE_ORIGIN).replace(/\/+$/, '')
  const jwt = options.jwt?.trim() || undefined
  const deviceMid = options.deviceMid?.trim() || undefined
  const language = options.language?.trim() || 'zh-CN'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  // The client keeps a module-level marketing sequence counter; a per-client
  // counter from 0 is equivalent per session.
  let marketingSeq = 0

  async function request(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<{ status: number; json: Record<string, unknown> | undefined; text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onExternalAbort = (): void => controller.abort()
    if (init.signal) {
      if (init.signal.aborted) controller.abort()
      else init.signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        method,
        headers: init.headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      })
      const text = await response.text()
      let json: Record<string, unknown> | undefined
      try {
        const parsed = JSON.parse(text) as unknown
        if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>
      } catch {
        // non-JSON body surfaced via text
      }
      return { status: response.status, json, text }
    } finally {
      clearTimeout(timer)
      init.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  function unwrapError(
    json: Record<string, unknown> | undefined,
    status: number,
    text: string,
  ): { code: number | string; message: string } {
    const code = json?.code !== undefined ? (json.code as number | string) : status >= 400 ? status : -1
    const rawMessage = json?.msg ?? json?.message
    const message = typeof rawMessage === 'string' && rawMessage.trim()
      ? rawMessage.trim()
      : text.length > 0 && text.length < 200
        ? text
        : `HTTP ${status}`
    return { code, message }
  }

  return {
    async getPreviews(signal?: AbortSignal): Promise<ClaimablePlan[]> {
      const url = `/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(options.appVersion)}&platform=${encodeURIComponent(options.platform)}`
      const headers: Record<string, string> = jwt ? { Authorization: `Bearer ${jwt}` } : {}
      if (deviceMid) headers['X-Device-Mid'] = deviceMid
      const { status, json, text } = await request('GET', url, { headers, signal })
      // code 0 with no `data` means "no manual campaigns for this account".
      if (status >= 200 && status < 300 && json?.code === 0 && json?.data === undefined) return []
      if (status < 200 || status >= 300 || (json?.code !== undefined && json.code !== 0) || json?.data === undefined) {
        const { code, message } = unwrapError(json, status, text)
        throw new ClaimPreviewError(`claim preview failed (${code}): ${message}`, status, code)
      }
      const data = json.data as { plans?: RawPlan[] }
      return (data.plans ?? []).flatMap((plan) => {
        const parsed = parsePlan(plan)
        return parsed ? [parsed] : []
      })
    },

    async getMarketingPlans(signal?: AbortSignal): Promise<ClaimablePlan[]> {
      if (!deviceMid) return []
      const headers: Record<string, string> = {
        'X-Device-Mid': deviceMid,
        'X-Client-Language': language,
        'X-ZCode-App-Version': options.appVersion,
      }
      if (jwt) headers.Authorization = `Bearer ${jwt}`
      const { status, json } = await request('GET', `/api/v1/marketing/touch?seq=${marketingSeq++}`, { headers, signal })
      if (status < 200 || status >= 300 || (json?.code !== undefined && json.code !== 0)) {
        // Marketing failures never block enumeration.
        return []
      }
      const deliveries = (json?.data as { deliveries?: unknown[] } | undefined)?.deliveries ?? []
      return parseMarketingDeliveries(deliveries)
    },

    async listPlans(signal?: AbortSignal): Promise<ClaimablePlan[]> {
      const [preview, banner] = await Promise.all([
        this.getPreviews(signal).catch((err: unknown) => {
          // 404 = campaign endpoint not deployed (pre-launch): empty list.
          if (err instanceof ClaimPreviewError && err.status === 404) return []
          throw err
        }),
        this.getMarketingPlans(signal),
      ])
      const seen = new Set(preview.map((plan) => plan.planId))
      const merged = [...preview]
      for (const plan of banner) {
        if (seen.has(plan.planId)) continue
        seen.add(plan.planId)
        merged.push(plan)
      }
      return merged
    },

    async claim(
      planId: string,
      captcha?: { verifyParam: string; region?: string },
      signal?: AbortSignal,
    ): Promise<ClaimOutcome> {
      if (!jwt) return { ok: false, planId, failureKind: 'login_required', code: 401, message: 'manual_claim_login_required' }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      }
      if (captcha) {
        headers['X-Aliyun-Captcha-Verify-Param'] = captcha.verifyParam
        if (captcha.region) headers['X-Aliyun-Captcha-Verify-Region'] = captcha.region
      }
      headers['X-ZCode-App-Version'] = options.appVersion
      headers['X-Platform'] = options.platform
      if (deviceMid) headers['X-Device-Mid'] = deviceMid
      const { status, json, text } = await request('POST', '/api/v1/zcode-plan/billing/claim', {
        body: { plan_id: planId }, headers, signal,
      })

      const data = json?.data as { plan?: RawPlan } | undefined
      const bizCode = json?.code !== undefined ? (json.code as number) : undefined
      const plan = data?.plan
      if (status >= 200 && status < 300 && bizCode === 0 && plan) {
        const outcome: ClaimOutcome = { ok: true, planId }
        if (Number.isFinite(plan.starts_at)) outcome.startsAt = plan.starts_at as number
        if (Number.isFinite(plan.ends_at)) outcome.endsAt = plan.ends_at as number
        return outcome
      }
      const { code, message } = unwrapError(json, status, text)
      const failureEndsAt = Number.isFinite(plan?.ends_at) ? (plan?.ends_at as number) : undefined
      const httpDerived = status >= 400 && bizCode === undefined
      return {
        ok: false,
        planId,
        failureKind: httpDerived
          ? (status === 401 ? 'login_required' : 'http_error')
          : classifyClaimCode(code),
        code,
        message,
        ...(failureEndsAt !== undefined ? { failureEndsAt } : {}),
      }
    },
  }
}
