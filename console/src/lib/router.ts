/**
 * Console routing. Hash-based on purpose: the SPA is served by the gateway
 * (or any static file server) with no rewrite rules, and /api/* must never be
 * shadowed by a client route.
 */
import { useCallback, useEffect, useState } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'provider'; id: string }
  | { name: 'extensions' }
  | { name: 'extension'; id: string }
  | { name: 'keys' }

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '')
  const [head, id] = h.split('/')
  if (head === 'providers' && id) return { name: 'provider', id: decodeURIComponent(id) }
  if (head === 'extensions' && id) return { name: 'extension', id: decodeURIComponent(id) }
  if (head === 'extensions') return { name: 'extensions' }
  if (head === 'keys') return { name: 'keys' }
  return { name: 'home' }
}

export function useRoute(): [Route, (to: string) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const navigate = useCallback((to: string) => {
    window.location.hash = to
  }, [])
  return [route, navigate]
}
