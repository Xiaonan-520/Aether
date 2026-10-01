/**
 * CodeArts credits (华为云「每日签到得积分」) — four-step signed flow:
 *   1. GET  /snap-manager/v1/statistics/plugin   (account / package)
 *   2. GET  /v1/ops/delivery?channel=IDE         (activity list)
 *   3. POST /v1/ops/claim   { campaignId, channel: 'IDE' }
 *   4. POST /v1/ops/confirm { campaignId }       (only when claim returns id != null)
 *
 * All requests are SDK-HMAC-SHA256 signed. The official portal path is not used
 * (BFF/browser-cookie only). No captcha or device token is involved.
 */
import { createHash } from 'node:crypto'
import type { ClaimOutcome } from '../../core/types.js'
import { signHuaweiRequest } from './sign.js'
import {
  CODEARTS_OPS_CLAIM_PATH,
  CODEARTS_OPS_CONFIRM_PATH,
  CODEARTS_OPS_DELIVERY_PATH,
  type CodeArtsProduct,
} from './product.js'
import type { CodeArtsCredential, Fetcher } from './protocol.js'

export interface CodeArtsCreditsDeps {
  product: CodeArtsProduct
  credential: CodeArtsCredential
  fetcher: Fetcher
}

function hashBody(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

async function signedRequest(
  deps: CodeArtsCreditsDeps,
  method: 'GET' | 'POST',
  path: string,
  body: Record<string, unknown> | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const url = `${deps.product.snapBase}${path}`
  const payload = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body))
  const signed = signHuaweiRequest(
    deps.credential.access_key_id,
    deps.credential.secret_access_key,
    deps.credential.security_token,
    method,
    url,
    payload,
    { 'agent-type': deps.product.agentTypeHeader, ...extraHeaders },
  )
  const res = await deps.fetcher(url, {
    method,
    headers: { ...signed.headers, 'user-agent': deps.product.userAgent },
    ...(method === 'GET' ? {} : { body: payload }),
  })
  const text = await res.text().catch(() => '')
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { ok: res.ok, status: res.status, body: parsed, text }
}

export interface CodeArtsCampaign {
  campaignId: string
  claimable: boolean
  title?: string
}

/** Step 2: list the available activities. */
export async function fetchCodeArtsCampaigns(deps: CodeArtsCreditsDeps): Promise<CodeArtsCampaign[]> {
  const res = await signedRequest(deps, 'GET', `${CODEARTS_OPS_DELIVERY_PATH}?channel=IDE`, undefined)
  if (!res.ok || res.body === null) return []
  const record = res.body as Record<string, unknown>
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.campaigns)
      ? record.campaigns
      : Array.isArray(record.result)
        ? record.result
        : []
  const campaigns: CodeArtsCampaign[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    const id = typeof r.campaignId === 'string' ? r.campaignId : typeof r.id === 'string' ? r.id : undefined
    if (!id) continue
    campaigns.push({
      campaignId: id,
      claimable: r.claimable === true || r.status === 'available' || r.status === 'claimable',
      ...(typeof r.title === 'string' ? { title: r.title } : {}),
    })
  }
  return campaigns
}

/** Four-step claim. Returns `not_available` when no campaign is claimable. */
export async function claimCodeArtsCredits(deps: CodeArtsCreditsDeps): Promise<ClaimOutcome> {
  const campaigns = await fetchCodeArtsCampaigns(deps)
  const target = campaigns.find((c) => c.claimable)
  if (!target) return { kind: 'not_available', message: 'no claimable CodeArts campaign' }
  const claim = await signedRequest(deps, 'POST', CODEARTS_OPS_CLAIM_PATH, {
    campaignId: target.campaignId,
    channel: 'IDE',
  })
  if (!claim.ok) {
    if (claim.status === 401 || claim.status === 403) return { kind: 'needs_auth', message: `HTTP ${claim.status}` }
    if (claim.status === 429) return { kind: 'rate_limited', message: `HTTP ${claim.status}` }
    return { kind: 'failed', message: claim.text.slice(0, 200) || `HTTP ${claim.status}` }
  }
  const record = (claim.body ?? {}) as Record<string, unknown>
  const confirmId = record.id ?? (record.data as Record<string, unknown> | undefined)?.id
  if (confirmId !== null && confirmId !== undefined) {
    // missing the confirm step leaves the credit pending
    await signedRequest(deps, 'POST', CODEARTS_OPS_CONFIRM_PATH, { campaignId: target.campaignId })
  }
  return { kind: 'success', credit: 0, message: 'CodeArts credit claimed' }
}

export { hashBody }
