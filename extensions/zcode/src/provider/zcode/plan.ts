/**
 * Which upstream gateway an account belongs to.
 *
 * ZCode issues two account modes and they need different request shapes:
 *
 * | plan        | upstream path                        | signing | system blocks |
 * |-------------|--------------------------------------|---------|---------------|
 * | coding-plan | `{apiBase}/zcode-plan/anthropic/v1/messages` | yes | omitted |
 * | start-plan  | `{apiBase}/zcode-plan/anthropic/v1/messages` | no  | required      |
 *
 * Both land on the same path today; what differs is the request body (the
 * start-plan edge inspects `system` and answers 3012 without the identity
 * blocks) and the captcha discipline (start-plan needs a captcha token on
 * every request, coding-plan only after a challenge).
 *
 * Detection follows the billing payload, which is the only authoritative
 * source: a trial/start plan reports `plan_id` values such as
 * `zcode-v3-start-plan-wk-1120` under `data.plans[]`, while coding plans carry
 * the coding-plan family. The result is cached per account in the kv table so
 * a request never has to pay for a billing round-trip; an unknown plan
 * defaults to `coding-plan` (the historically supported mode) until the first
 * quota refresh proves otherwise.
 *
 * Ported in spirit from TriDefender/zcode-api (`config.plan`, CC BY-NC-SA 4.0
 * — see THIRD-PARTY-NOTICES.md).
 */
export type ZCodePlan = 'coding-plan' | 'start-plan'

/** `plan_id` / `planId` substrings that mark a trial ("start") plan. */
const START_PLAN_MARKERS = ['start-plan', 'start_plan', 'startplan'] as const

/**
 * Classify one billing payload. Returns undefined when the payload carries no
 * usable plan information (fetch failed, empty plan list, unknown ids) so the
 * caller keeps whatever it had.
 */
export function detectPlanFromBilling(billing: unknown): ZCodePlan | undefined {
  if (!billing || typeof billing !== 'object') return undefined
  const root = billing as Record<string, unknown>
  const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>
  const plans = data.plans
  if (!Array.isArray(plans) || plans.length === 0) return undefined

  let sawActive = false
  for (const plan of plans as Array<Record<string, unknown>>) {
    if (!plan || typeof plan !== 'object') continue
    const status = typeof plan.status === 'string' ? plan.status.toLowerCase() : ''
    if (status.length > 0 && status !== 'active') continue
    sawActive = true
    const id = String(plan.plan_id ?? plan.planId ?? '')
    const name = String(plan.name ?? '')
    const haystack = `${id} ${name}`.toLowerCase()
    if (START_PLAN_MARKERS.some((marker) => haystack.includes(marker))) return 'start-plan'
  }
  // Active plans exist and none looked like a trial plan.
  return sawActive ? 'coding-plan' : undefined
}

/**
 * The start-plan edge expects the model id as-is; the coding-plan endpoint is
 * case-insensitive in practice, so the same mapping serves both.
 */
export function planLabel(plan: ZCodePlan): string {
  return plan === 'start-plan' ? 'start-plan' : 'coding-plan'
}
