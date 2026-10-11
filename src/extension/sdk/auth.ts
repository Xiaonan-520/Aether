/**
 * Extension SDK — bearer-token auth (mirror of extensions' server/auth.ts).
 * The Gateway Manager/Core presents `Authorization: Bearer <extension-token>`;
 * this is entirely distinct from any provider credential.
 */
import type { IncomingMessage } from 'node:http'

export class ExtensionAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtensionAuthError'
  }
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1] : undefined
}

/** Reject requests lacking the correct bearer when a token is configured; open in local/dev mode. */
export function checkExtensionAuth(
  req: IncomingMessage,
  configuredToken: string | undefined,
): void {
  if (!configuredToken) return
  const token = bearerToken(req)
  if (!token) throw new ExtensionAuthError('missing Authorization: Bearer <token>')
  if (token.length !== configuredToken.length || !timingSafeEqual(token, configuredToken)) {
    throw new ExtensionAuthError('extension auth token mismatch')
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  let result = 0
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return result === 0
}
