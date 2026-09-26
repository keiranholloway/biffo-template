import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEV_CLIENT_ID, generateDevKeypair, mintDevToken } from './dev-auth.js'

function verifies(token: string, jwksJson: string): boolean {
  const [h, p, s] = token.split('.') as [string, string, string]
  const jwk = (JSON.parse(jwksJson) as { keys: Array<Record<string, string>> }).keys[0]!
  const key = createPublicKey({ key: jwk, format: 'jwk' })
  return verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))
}
const claimsOf = (t: string) =>
  JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>

describe('dev token minter', () => {
  it('mints an RS256 token the published JWKS verifies, carrying aud + groups + kid', () => {
    const kp = generateDevKeypair()
    const t = mintDevToken(kp.privateKeyPem, { groups: ['admin', 'founder'] })
    expect(verifies(t, kp.jwksJson)).toBe(true)
    const c = claimsOf(t)
    expect(c.aud).toBe(DEV_CLIENT_ID)
    expect(c['cognito:groups']).toEqual(['admin', 'founder'])
    expect(JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString()).kid).toBe(
      JSON.parse(kp.jwksJson).keys[0].kid,
    )
  })

  it('a token signed by a DIFFERENT keypair does not verify (the wrong-key control input)', () => {
    const mine = generateDevKeypair()
    const other = generateDevKeypair()
    expect(verifies(mintDevToken(other.privateKeyPem, { groups: ['admin'] }), mine.jwksJson)).toBe(
      false,
    )
  })

  it('a negative ttl mints an already-expired token; no groups omits the claim', () => {
    const kp = generateDevKeypair()
    const expired = claimsOf(mintDevToken(kp.privateKeyPem, { ttlSeconds: -60 }))
    expect(Number(expired.exp)).toBeLessThan(Math.floor(Date.now() / 1000))
    expect('cognito:groups' in expired).toBe(false)
  })
})
