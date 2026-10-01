/**
 * Minimal fetch double for Buddy-family adapter tests.
 * Each entry is matched against the request URL; the first match wins.
 */
export interface BuddyFetchRoute {
  match: string
  json?: unknown
  status?: number
  /** raw SSE body for streaming endpoints */
  sse?: string
}

export function fetcherFor(routes: BuddyFetchRoute[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    for (const route of routes) {
      if (!url.includes(route.match)) continue
      const status = route.status ?? 200
      if (route.sse !== undefined) {
        return new Response(route.sse, {
          status,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response(JSON.stringify(route.json ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ code: -1, msg: `no route for ${url}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}
