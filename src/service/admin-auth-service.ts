/**
 * Admin identity and login sessions.
 *
 * Trust domains kept deliberately separate:
 *   - password    → scrypt digest in admin_users; never leaves this service
 *   - session     → opaque random token, SHA-256 in admin_sessions
 *   - static admin token (GATEWAY_ADMIN_TOKEN) → env var, checked in the HTTP
 *     layer as a backward-compatible operator fallback
 *   - extension hop tokens → Extension Manager, a different subsystem entirely
 *
 * Nothing here touches provider credentials, gateway API keys, or the manager.
 */
import { randomBytes } from 'node:crypto'
import type { ServiceContext } from './context.js'
import type { AdminSessionRecord, AdminUserRecord } from '../store/types.js'
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../core/auth/password.js'
import { generateSessionToken, hashSessionToken } from '../core/auth/session-token.js'
import { normalizeEmail, redactEmail } from '../core/auth/email.js'

/** Session lifetime. Rotated on login; revoked on logout. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

/** Failed-login throttling: after N failures in the window, lock the identity. */
export const LOGIN_MAX_ATTEMPTS = 5
export const LOGIN_WINDOW_MS = 15 * 60 * 1000

/** Error codes surfaced to the client; deliberately vague where it matters. */
export type AuthErrorCode =
  | 'registration_closed'
  | 'invalid_email'
  | 'weak_password'
  | 'email_taken'
  | 'invalid_credentials'
  | 'too_many_attempts'
  | 'not_initialized'
  | 'unauthorized'

export class AuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 409 | 429,
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/** Safe projection of an admin identity — never includes the digest. */
export interface AdminUserView {
  id: string
  email: string
  createdAt: number
}

/** What a successful login/registration returns. `token` is shown once. */
export interface AuthSessionResult {
  token: string
  expiresAt: number
  user: AdminUserView
}

/** Public status used by the console to decide which screen to render. */
export interface AuthStatus {
  /** True once the single admin account exists; public registration is closed. */
  initialized: boolean
  user?: AdminUserView
}

interface AttemptRecord {
  failures: number
  firstFailureAt: number
}

function toView(user: AdminUserRecord): AdminUserView {
  return { id: user.id, email: user.email, createdAt: user.createdAt }
}

/**
 * Fixed dummy digest used to equalize timing when the email does not exist.
 * Without it, "no such user" would return measurably faster than "wrong
 * password" and leak account existence.
 */
const DUMMY_DIGEST =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

export class AdminAuthService {
  /**
   * In-process failed-login tracker. Keyed by normalized email, not by IP:
   * an attacker with one identity is throttled regardless of source address,
   * and a shared NAT does not lock out unrelated operators. Process-local by
   * design (single-instance deployment, same as the manager's lifecycle locks).
   */
  private readonly attempts = new Map<string, AttemptRecord>()

  constructor(private readonly ctx: ServiceContext) {}

  // -- status ----------------------------------------------------------------

  /**
   * Open endpoint. Reports whether the gateway has an admin yet and, when the
   * caller is already authenticated, who it is.
   *
   * Never reveals the admin's email to an unauthenticated caller — only the
   * boolean that registration is closed.
   */
  status(sessionUser?: AdminUserView): AuthStatus {
    const initialized = this.ctx.store.countAdminUsers() > 0
    if (!initialized) return { initialized: false }
    return sessionUser ? { initialized: true, user: sessionUser } : { initialized: true }
  }

  // -- registration ----------------------------------------------------------

  /**
   * Register the first and only admin.
   *
   * Concurrency: the store enforces uniqueness on the normalized email, so two
   * simultaneous calls cannot both insert. We also re-check the count first to
   * fail fast with `registration_closed` in the common case.
   */
  async register(input: { email?: unknown; password?: unknown }): Promise<AuthSessionResult> {
    if (this.ctx.store.countAdminUsers() > 0) {
      throw new AuthError(409, 'registration_closed', 'an administrator account already exists')
    }

    const email = normalizeEmail(input.email)
    if (!email) {
      throw new AuthError(400, 'invalid_email', 'a valid email address is required')
    }
    const password = this.requirePassword(input.password)
    const passwordHash = await hashPassword(password)

    const now = this.ctx.now()
    const user: AdminUserRecord = {
      id: `admin_${randomBytes(8).toString('hex')}`,
      email,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    }

    const created = this.ctx.store.createFirstAdminUser(user)
    if (!created.ok) {
      // Either another request won the race, or an admin already existed.
      // Both mean registration is closed — never surface the raw store message.
      throw new AuthError(409, 'registration_closed', 'an administrator account already exists')
    }

    this.audit('admin.registered', { email: redactEmail(email) })
    return this.issueSession(user, now)
  }

  // -- login -----------------------------------------------------------------

  async login(input: { email?: unknown; password?: unknown }): Promise<AuthSessionResult> {
    const email = normalizeEmail(input.email)
    const password = typeof input.password === 'string' ? input.password : ''

    // Throttle before doing any crypto so a locked identity costs almost nothing.
    this.assertNotThrottled(email ?? '')

    const user = email ? this.ctx.store.getAdminUserByEmail(email) : undefined

    // Always run a scrypt verification: a dummy digest for unknown emails keeps
    // the response time indistinguishable from a wrong password.
    const digest = user?.passwordHash ?? DUMMY_DIGEST
    const passwordOk = await verifyPassword(password, digest)
    const ok = Boolean(user) && passwordOk

    if (!ok) {
      if (email) this.recordFailure(email)
      // Same message and status for "no such account" and "wrong password".
      throw new AuthError(401, 'invalid_credentials', 'email or password is incorrect')
    }

    this.attempts.delete(email!)
    this.audit('admin.login', { email: redactEmail(user!.email) })
    return this.issueSession(user!, this.ctx.now())
  }

  // -- sessions --------------------------------------------------------------

  /**
   * Resolve a bearer token to its admin user. Returns undefined for a token
   * that is unknown, expired or revoked — callers treat all three the same.
   */
  authenticate(token: string): AdminUserView | undefined {
    const record = this.ctx.store.getAdminSessionByTokenHash(hashSessionToken(token))
    if (!record) return undefined
    const now = this.ctx.now()
    if (record.revokedAt !== null) return undefined
    if (record.expiresAt <= now) return undefined
    const user = this.ctx.store.getAdminUserById(record.userId)
    if (!user) return undefined
    // Best-effort activity stamp; a failure here must not deny a valid session.
    try {
      this.ctx.store.touchAdminSession(record.id, now)
    } catch {
      /* ignore */
    }
    return toView(user)
  }

  /** Expiry of the session behind `token`, or null when unknown/expired/revoked. */
  sessionExpiry(token: string): number | null {
    const record = this.ctx.store.getAdminSessionByTokenHash(hashSessionToken(token))
    if (!record || record.revokedAt !== null) return null
    return record.expiresAt > this.ctx.now() ? record.expiresAt : null
  }

  /** Revoke the session behind `token`. Idempotent: unknown tokens are a no-op. */
  logout(token: string): void {
    const record = this.ctx.store.getAdminSessionByTokenHash(hashSessionToken(token))
    if (!record) return
    this.ctx.store.revokeAdminSession(record.id, this.ctx.now())
    this.audit('admin.logout', { sessionId: record.id })
  }

  /** Drop sessions that are past their expiry. Called by the scheduler. */
  pruneSessions(): number {
    return this.ctx.store.pruneAdminSessions(this.ctx.now())
  }

  // -- internals -------------------------------------------------------------

  private issueSession(user: AdminUserRecord, now: number): AuthSessionResult {
    const token = generateSessionToken()
    const session: AdminSessionRecord = {
      id: `sess_${randomBytes(8).toString('hex')}`,
      userId: user.id,
      tokenHash: hashSessionToken(token),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastUsedAt: null,
      revokedAt: null,
    }
    const created = this.ctx.store.createAdminSession(session)
    if (!created.ok) {
      // A token collision is astronomically unlikely; fail closed rather than
      // retrying into an unknown state.
      throw new AuthError(401, 'unauthorized', 'could not establish a session')
    }
    return { token, expiresAt: session.expiresAt, user: toView(user) }
  }

  private requirePassword(input: unknown): string {
    if (typeof input !== 'string') {
      throw new AuthError(400, 'weak_password', `password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    }
    if (input.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError(400, 'weak_password', `password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    }
    if (input.length > MAX_PASSWORD_LENGTH) {
      throw new AuthError(400, 'weak_password', `password must be at most ${MAX_PASSWORD_LENGTH} characters`)
    }
    return input
  }

  private assertNotThrottled(email: string): void {
    const record = this.attempts.get(email)
    if (!record) return
    const now = this.ctx.now()
    if (now - record.firstFailureAt > LOGIN_WINDOW_MS) {
      this.attempts.delete(email)
      return
    }
    if (record.failures >= LOGIN_MAX_ATTEMPTS) {
      throw new AuthError(429, 'too_many_attempts', 'too many failed attempts; try again later')
    }
  }

  private recordFailure(email: string): void {
    const now = this.ctx.now()
    const record = this.attempts.get(email)
    if (!record || now - record.firstFailureAt > LOGIN_WINDOW_MS) {
      this.attempts.set(email, { failures: 1, firstFailureAt: now })
      return
    }
    record.failures++
  }

  private audit(kind: string, detail: Record<string, unknown>): void {
    // Audits record that something happened — never a password, digest or token.
    this.ctx.store.addEvent({ ts: this.ctx.now(), level: 'info', kind, ...detail })
  }
}
