/**
 * Minimal data-fetching hook: loading / error / data + refetch. Kept tiny on
 * purpose — the console has ~5 queries and no cache graph. Data is fetched in
 * an effect keyed on `key`; the fetch function is read inside the effect so
 * callers can pass inline closures without retriggering loops.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiError } from './api'

export interface QueryState<T> {
  data: T | null
  error: ApiError | Error | null
  loading: boolean
  /** timestamp of the last successful fetch; null until then */
  fetchedAt: number | null
  refetch: () => void
}

export function useQuery<T>(fn: () => Promise<T>, deps: unknown[]): QueryState<T> {
  const [state, setState] = useState<{
    data: T | null
    error: ApiError | Error | null
    loading: boolean
    fetchedAt: number | null
  }>({ data: null, error: null, loading: true, fetchedAt: null })
  const [nonce, setNonce] = useState(0)
  const fnRef = useRef(fn)

  useEffect(() => {
    fnRef.current = fn
  })

  useEffect(() => {
    let cancelled = false
    fnRef
      .current()
      .then((result) => {
        if (cancelled) return
        setState({ data: result, error: null, loading: false, fetchedAt: Date.now() })
      })
      .catch((err: ApiError | Error) => {
        if (cancelled) return
        setState((prev) => ({ ...prev, error: err, loading: false }))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, refetch }
}
