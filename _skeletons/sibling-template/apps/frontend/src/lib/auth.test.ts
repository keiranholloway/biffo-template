import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getCurrentUser = vi.fn()
const poolConstructor = vi.fn()

vi.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: class {
    constructor(...args: unknown[]) {
      poolConstructor(...args)
    }
    getCurrentUser = getCurrentUser
  },
}))

type SessionCallback = (err: Error | null, session: unknown) => void

function userWithSession(session: unknown, err: Error | null = null) {
  return {
    getSession: (cb: SessionCallback) => {
      cb(err, session)
    },
  }
}

function configureCognitoEnv() {
  vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_USER_POOL_ID', 'us-east-1_TESTPOOL')
  vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_CLIENT_ID', 'testclientid')
}

// Each test re-imports the module fresh: the pool is memoised after its first
// construction, so a module instance left over from a previous test would carry
// that test's env into the next one.
async function loadAuth() {
  vi.resetModules()
  return await import('@/lib/auth')
}

describe('getCurrentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configureCognitoEnv()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns null when no user is stored in the shared localStorage session', async () => {
    const { getCurrentSession } = await loadAuth()
    getCurrentUser.mockReturnValue(null)
    await expect(getCurrentSession()).resolves.toBeNull()
  })

  it('returns the session the portal established when it is valid', async () => {
    const { getCurrentSession } = await loadAuth()
    const session = { isValid: () => true }
    getCurrentUser.mockReturnValue(userWithSession(session))
    await expect(getCurrentSession()).resolves.toBe(session)
  })

  it('returns null when the stored session is expired/invalid', async () => {
    const { getCurrentSession } = await loadAuth()
    getCurrentUser.mockReturnValue(userWithSession({ isValid: () => false }))
    await expect(getCurrentSession()).resolves.toBeNull()
  })

  it('returns null when getSession errors', async () => {
    const { getCurrentSession } = await loadAuth()
    getCurrentUser.mockReturnValue(userWithSession(null, new Error('nope')))
    await expect(getCurrentSession()).resolves.toBeNull()
  })
})

// The CognitoUserPool constructor throws ("Both UserPoolId and ClientId are
// required") when either value is missing, and `next build` prerenders `/` in
// Node — which imports this module. Building the pool at module scope therefore
// made the skeleton un-buildable without real Cognito credentials in scope.
// These tests pin that shut.
describe('lazy pool construction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not construct the pool merely by importing the module', async () => {
    configureCognitoEnv()
    await loadAuth()
    expect(poolConstructor).not.toHaveBeenCalled()
  })

  it('imports cleanly with no Cognito env vars set', async () => {
    vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_USER_POOL_ID', '')
    vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_CLIENT_ID', '')
    await expect(loadAuth()).resolves.toBeDefined()
    expect(poolConstructor).not.toHaveBeenCalled()
  })

  it('resolves null instead of throwing when Cognito env vars are absent', async () => {
    vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_USER_POOL_ID', '')
    vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_CLIENT_ID', '')
    const { getCurrentSession } = await loadAuth()
    await expect(getCurrentSession()).resolves.toBeNull()
    expect(poolConstructor).not.toHaveBeenCalled()
  })

  it('constructs the pool once, on first session read, from the core env vars', async () => {
    configureCognitoEnv()
    const { getCurrentSession } = await loadAuth()
    getCurrentUser.mockReturnValue(null)

    await getCurrentSession()
    await getCurrentSession()

    expect(poolConstructor).toHaveBeenCalledTimes(1)
    expect(poolConstructor).toHaveBeenCalledWith({
      UserPoolId: 'us-east-1_TESTPOOL',
      ClientId: 'testclientid',
    })
  })
})

// ADR-0007: the core portal owns authentication; a sibling only reads the
// shared session. Exporting sign-in machinery from a sibling invites a second
// login path that bypasses the portal and silently breaks single-sign-on.
// If you are here because you deliberately added one of these, that decision
// belongs in an ADR — not in a green test suite.
describe('sibling auth surface', () => {
  it('exposes only session reading — no sign-in/sign-out machinery', async () => {
    const authModule = await loadAuth()
    expect(Object.keys(authModule).sort()).toEqual(['getCurrentSession'])
  })
})
