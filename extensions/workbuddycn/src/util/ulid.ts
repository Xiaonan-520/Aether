/**
 * Tiny opaque-id helpers. Account / request ids are protocol-opaque and must
 * never embed upstream ids, emails, phones or credentials.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function randPart(): string {
  let out = ''
  for (let i = 0; i < 16; i++) {
    out += CROCKFORD[Math.floor(Math.random() * 32)]
  }
  return out
}

/** 10-char Crockford time part (ms since epoch, big-endian). */
function timePart(now: number): string {
  let value = now
  const stack: string[] = []
  for (let i = 0; i < 10; i++) {
    stack.push(CROCKFORD[value % 32] ?? '0')
    value = Math.floor(value / 32)
  }
  return stack.reverse().join('')
}

/** Opaque, sortable account/request id. Not a real ULID, same guarantees. */
export function newId(prefix: string): string {
  return `${prefix}_${timePart(Date.now())}${randPart()}`
}

/** Decode the embedded timestamp (used by retention logic). */
export function decodeTime(id: string): number {
  const body = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id
  const time = body.slice(0, 10)
  let value = 0
  for (const ch of time) {
    value = value * 32 + CROCKFORD.indexOf(ch.toUpperCase())
  }
  return value
}
