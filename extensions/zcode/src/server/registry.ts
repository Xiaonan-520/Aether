/**
 * Tracks in-flight upstream requests so a client disconnect (or a deadline) can
 * abort the underlying fetch/stream. Keyed by the protocol requestId.
 */
export class ActiveRequestRegistry {
  private readonly inflight = new Map<string, { controller: AbortController; accountId: string; startedAt: number }>()

  register(requestId: string, accountId: string, controller: AbortController): void {
    this.inflight.set(requestId, { controller, accountId, startedAt: Date.now() })
  }

  unregister(requestId: string): void {
    this.inflight.delete(requestId)
  }

  abort(requestId: string): boolean {
    const entry = this.inflight.get(requestId)
    if (!entry || entry.controller.signal.aborted) return false
    entry.controller.abort()
    this.inflight.delete(requestId)
    return true
  }

  abortAll(): void {
    for (const [, entry] of this.inflight) entry.controller.abort()
    this.inflight.clear()
  }

  size(): number {
    return this.inflight.size
  }
}
