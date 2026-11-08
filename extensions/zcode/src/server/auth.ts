/**
 * Extension API authentication. The Gateway Manager/Core presents
 * `Authorization: Bearer <extension-token>` which is checked against the
 * configured EXTENSION_AUTH_TOKEN. This is entirely distinct from any Tencent
 * credential.
 */
import type { IncomingMessage } from 'node:http'

/**
 * Marker thrown by the auth gate so the HTTP server can map it to an explicit
 * 401 "extension authentication failure" per protocol §26/§27.
 */
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

/**
 * If EXTENSION_AUTH_TOKEN is configured, reject requests lacking the correct
 * bearer credential. When no token is configured (local/dev use), all requests pass.
 */
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