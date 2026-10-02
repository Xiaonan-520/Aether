/**
 * Pluggable captcha handler contract.
 *
 * The provider never implements (or imports) a concrete captcha solver: it
 * only describes the *challenge* it received and asks the injected handler
 * chain for a verification token. Handlers decide the policy — the built-in
 * default resolves challenges through a human (manual browser verification
 * submitted via the admin API); anything more automated would violate this
 * repository's no-captcha-bypass boundary (see README "安全与合规边界").
 *
 * A handler that cannot complete the challenge MUST return
 * `{ ok: false, reason: 'unavailable' }` — there is deliberately no way to
 * fabricate a token through this interface.
 */

/** Why the provider is asking for a captcha token right now. */
export type CaptchaChallengeKind =
  /** No token is cached; this is the first attempt of a request. */
  | 'initial'
  /** Upstream rejected the token we sent (403 challenge response). */
  | 'rejected_403'
  /** Upstream answered with the in-body `{"code":3007}` challenge variant. */
  | 'in_body_3007'

/** Diagnostic classification of a rejected token (Aliyun verify codes). */
export type CaptchaRejectClass = 'duplicate' | 'ip_block' | 'unknown'

export interface CaptchaChallenge {
  kind: CaptchaChallengeKind
  /** Populated for `rejected_403` / `in_body_3007` challenges. */
  rejectClass?: CaptchaRejectClass
  /** Short upstream excerpt or error detail for diagnostics. */
  detail?: string
}

export type CaptchaResult =
  | { ok: true; verifyParam: string; region?: string }
  | { ok: false; reason: 'unavailable' }

export interface CaptchaHandler {
  /** Stable identifier for logs/tests ('manual', 'external', …). */
  readonly id: string
  /**
   * Resolve a captcha challenge. Implementations must only use legitimate,
   * human-driven flows (e.g. the official Aliyun widget in a real browser);
   * automating or bypassing the verification is out of contract.
   */
  handle(challenge: CaptchaChallenge): Promise<CaptchaResult>
}
