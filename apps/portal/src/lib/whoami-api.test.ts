import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api-client'
import { fetchWhoami, resolveWhoami, whoamiFromClaims } from './whoami-api'

const CLAIMS = {
  sub: 'sub-123',
  email: 'someone@example.com',
  'cognito:username': 'someone',
  'cognito:groups': ['admin'],
}

describe('fetchWhoami', () => {
  it('calls the path core serves', async () => {
    const get = vi.fn().mockResolvedValue({})

    await fetchWhoami({ get })

    // The literal matters: this string and the route registered in
    // services/api/src/api/routers/whoami.py are the contract, and they were
    // out of step for two days.
    expect(get).toHaveBeenCalledWith('/api/v1/whoami')
  })
})

describe('whoamiFromClaims', () => {
  it('carries the identity the verified token already proves', () => {
    const result = whoamiFromClaims(CLAIMS)

    expect(result.sub).toBe('sub-123')
    expect(result.email).toBe('someone@example.com')
    expect(result.username).toBe('someone')
  })

  it('grants nothing the token does not prove', () => {
    // The fallback must never be a privilege escalation: whatever the caller
    // actually holds server-side, this claims none of it. Routing can then only
    // act on `cognito:groups`, which is signed, and which AuthGuard re-checks at
    // the destination anyway.
    const result = whoamiFromClaims({ ...CLAIMS, is_platform_admin: true, roles: ['anything'] })

    expect(result.is_platform_admin).toBe(false)
    expect(result.roles).toEqual([])
    expect(result.permissions).toEqual([])
    expect(result.marketplace_role).toBeNull()
  })

  it('tolerates a token missing the optional claims', () => {
    const result = whoamiFromClaims({})

    expect(result.sub).toBe('')
    expect(result.email).toBe('')
    expect(result.username).toBe('')
  })
})

describe('resolveWhoami', () => {
  it('returns the API answer when the route is served', async () => {
    const served = {
      sub: 's',
      email: 'e',
      username: 'u',
      user_id: 'u1',
      is_platform_admin: true,
      permissions: ['a'],
      marketplace_role: null,
      roles: [{ role: 'manager', scope_level: 'tenant' }],
    }
    const get = vi.fn().mockResolvedValue(served)

    expect(await resolveWhoami({ get }, CLAIMS)).toEqual(served)
  })

  it('falls back to the token claims on 404, rather than stranding the caller', async () => {
    // The reported incident: sign-in succeeded at Cognito, the API had no such
    // route, and the user was returned to the form as if the password were wrong.
    const get = vi.fn().mockRejectedValue(new ApiError(404, 'Not Found'))

    const result = await resolveWhoami({ get }, CLAIMS)

    expect(result.sub).toBe('sub-123')
    expect(result.is_platform_admin).toBe(false)
  })

  it.each([
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [500, 'Internal Server Error'],
  ])('propagates %i rather than degrading', async (status, message) => {
    // Only a 404 means "this deployment does not serve the contract". Falling
    // back on anything else would route a real admin to no-access on a blip and
    // make a broken API look like a permissions problem.
    const get = vi.fn().mockRejectedValue(new ApiError(status, message))

    await expect(resolveWhoami({ get }, CLAIMS)).rejects.toThrow(message)
  })

  it('propagates a network failure rather than degrading', async () => {
    const get = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(resolveWhoami({ get }, CLAIMS)).rejects.toThrow('Failed to fetch')
  })
})
