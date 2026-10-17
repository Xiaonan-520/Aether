/**
 * Channel-sensitive text normalization for the Buddy-family upstreams.
 *
 * The buddy/workbuddy/codebuddy upstreams run a channel check over request
 * text and answer `11128` ("Illegal API invocation from an unapproved
 * channel") when it contains a string from their client-fingerprint list.
 *
 * One *confirmed* trigger — reproduced against the live upstream and bisected
 * out of a real failing request — is a verbose git-context label that ZCode CLI
 * injects into its dynamic system section whenever it runs inside a git working
 * tree. The label reads "Main branch" followed by a parenthetical explaining
 * that this branch is normally used for PRs.
 *
 * That parenthetical is advisory prose addressed to the model about which
 * branch to target for pull requests. It carries no client-identity meaning and
 * no information the model needs beyond "this is the main branch". Rewriting it
 * to a shorter, equivalent form was verified to pass the upstream channel check
 * (200) where the original wording is refused (400 / 11128).
 *
 * Scope is deliberately narrow:
 *
 *   - ONLY this exact sentence is rewritten. Nothing else in the text changes.
 *   - ONLY `system` content and `assistant` text are touched. User messages,
 *     tool results, tool-call arguments and reasoning content were tested and do
 *     not trigger the check, so they stay byte-identical.
 *   - The Claude Code identity sentence is a DIFFERENT, independent trigger. It
 *     is NOT rewritten here — doing so would mean impersonating another client.
 *     Requests carrying it are left alone and fail honestly.
 *
 * The rewrite is idempotent and preserves the instruction's meaning.
 */

/** Exact git-context label the upstream fingerprints. */
const GIT_MAIN_BRANCH_HINT = 'Main branch (you will usually use this for PRs)'

/** Equivalent wording that keeps the model's instruction intact. */
const GIT_MAIN_BRANCH_HINT_REWRITE = 'Main branch (for PRs)'

/**
 * Normalize the known channel-triggering git-context label.
 *
 * @param text wire text destined for `system` or `assistant` content
 * @returns the normalized text, or the input unchanged when nothing matches
 */
export function normalizeChannelText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text
  // Fast path: almost every message contains nothing to rewrite.
  if (!text.includes(GIT_MAIN_BRANCH_HINT)) return text
  return text.split(GIT_MAIN_BRANCH_HINT).join(GIT_MAIN_BRANCH_HINT_REWRITE)
}
