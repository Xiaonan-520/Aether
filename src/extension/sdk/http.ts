/**
 * Extension SDK — HTTP primitives: path parsing, route matching, JSON body
 * helpers. Framework-free so extensions need zero runtime dependencies.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { errors, ExtensionProtocolError } from './errors.js'

export interface SdkRequestContext {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  requestId: string
}

export interface SdkRoute {
  method: string
  path: string
  handler: (ctx: SdkRequestContext) => Promise<void> | void
}

export function parsePath(raw: string): { pathname: string; query: string } {
  const q = raw.indexOf('?')
  return q === -1 ? { pathname: raw, query: '' } : { pathname: raw.slice(0, q), query: raw.slice(q + 1) }
}

export function matchRoute(
  routes: SdkRoute[],
  method: string,
  pathname: string,
): { handler: SdkRoute['handler']; params: Record<string, string> } | undefined {
  const segments = pathname.split('/').filter((s) => s.length > 0)
  for (const route of routes) {
    if (route.method !== method) continue
    const routeSegments = route.path.split('/').filter((s) => s.length > 0)
    if (routeSegments.length !== segments.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < routeSegments.length; i++) {
      const rs = routeSegments[i]!
      const ss = segments[i]!
      if (rs.startsWith(':')) params[rs.slice(1)] = decodeURIComponent(ss)
      else if (rs !== ss) { ok = false; break }
    }
    if (ok) return { handler: route.handler, params }
  }
  return undefined
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) throw errors.terminal('body must be a JSON object')
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof ExtensionProtocolError) throw error
    throw errors.terminal('invalid JSON body')
  }
}
