/**
 * Email normalization for admin accounts.
 *
 * Deliberately conservative: no provider-specific rewriting (no Gmail dot
 * stripping, no sub-addressing removal) because those rules are provider
 * behaviour, not identity, and silently merging two addresses that the
 * operator considers distinct would be a surprise. We only do what RFC 5321
 * says is safely equivalent for the domain part, plus whitespace trimming.
 *
 * What we do:
 *   - trim leading/trailing whitespace
 *   - lowercase the whole address (domains are case-insensitive; local parts
 *     in practice are too for every identity provider worth using here)
 *   - reject anything that does not look like a single addr-spec
 *
 * Returns null when the input is not a usable address.
 */

// Intentionally permissive but structurally strict: one @, non-empty local
// part, a domain with at least one dot, no whitespace or control characters.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/

const MAX_EMAIL_LENGTH = 254

export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return null
  if (!EMAIL_SHAPE.test(trimmed)) return null
  // A second @ would mean the address is not an addr-spec.
  if (trimmed.indexOf('@') !== trimmed.lastIndexOf('@')) return null
  return trimmed
}

/** Redacted form for logs/audit: keeps the domain so operators can tell accounts apart. */
export function redactEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const head = local.slice(0, 1)
  return `${head}***@${domain}`
}
