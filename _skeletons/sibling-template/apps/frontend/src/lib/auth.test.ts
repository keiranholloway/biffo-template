import { beforeEach, describe, expect, it, vi } from 'vitest'

const getCurrentUser = vi.fn()

vi.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: class {
    getCurrentUser = getCurrentUser
  },
}))

const { getCurrentSession } = await import('@/lib/auth')
const authModule = await import('@/lib/auth')

type SessionCallback = (err: Error | null, session: unknown) => void

function userWithSession(session: unknown, err: Error | null = null) {
  return {
    getSession: (cb: SessionCallback) => {
      cb(err, session)
    },
  }
}

describe('getCurrentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when no user is stored in the shared localStorage session', async () => {
    getCurrentUser.mockReturnValue(null)
    await expect(getCurrentSession()).resolves.toBeNull()
  })

  it('returns the session the portal established when it is valid', async () => {
    const session = { isValid: () => true }
    getCurrentUser.mockReturnValue(userWithSession(session))
    await expect(getCurrentSession()).resolves.toBe(session)
  })

  it('returns null when the stored session is expired/invalid', async () => {
    getCurrentUser.mockReturnValue(userWithSession({ isValid: () => false }))
    await expect(getCurrentSession()).resolves.toBeNull()
  })

  it('returns null when getSession errors', async () => {
    getCurrentUser.mockReturnValue(userWithSession(null, new Error('nope')))
    await expect(getCurrentSession()).resolves.toBeNull()
  })
})

// ADR-0007: the core portal owns authentication; a sibling only reads the
// shared session. Exporting sign-in machinery from a sibling invites a second
// login path that bypasses the portal and silently breaks single-sign-on.
// If you are here because you deliberately added one of these, that decision
// belongs in an ADR — not in a green test suite.
describe('sibling auth surface', () => {
  it('exposes only session reading — no sign-in/sign-out machinery', () => {
    expect(Object.keys(authModule).sort()).toEqual(['getCurrentSession'])
  })
})
