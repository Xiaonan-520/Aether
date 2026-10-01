import { describe, expect, it } from 'vitest'
import { CredentialCipher } from '../src/store/crypto.js'

describe('smoke / environment', () => {
  it('typechecks runtime imports and encrypts round-trip', () => {
    const cipher = new CredentialCipher('0123456789abcdef')
    const blob = cipher.encrypt('secret-token')
    expect(cipher.decrypt(blob.ciphertext, blob.iv, blob.tag)).toBe('secret-token')
  })

  it('rejects a weak secret', () => {
    expect(() => new CredentialCipher('short')).toThrow(/GATEWAY_SECRET/)
  })
})
