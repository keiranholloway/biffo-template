import { beforeEach, describe, expect, it, vi } from 'vitest'

const getCurrentUser = vi.fn()
const poolConstructor = vi.fn()

vi.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: class {
    constructor(...args: unknown[]) {
      poolConstructor(...args)
    }
    getCurrentUser = getCurrentUser
  },
  CognitoUser: vi.fn(),
  AuthenticationDetails: vi.fn(),
}))

const resolveCoreIdentity = vi.fn()
vi.mock('./identity', () => ({ resolveCoreIdentity }))

// Fresh module each test: the pool is memoised after first construction.
async function loadAuth() {
  vi.resetModules()
  return await import('./auth')
}

describe('portal auth — runtime identity resolution (#403)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not construct the pool merely by importing the module (build-safe)', async () => {
    resolveCoreIdentity.mockResolvedValue({ userPoolId: 'p', clientId: 'c' })
    await loadAuth()
    expect(poolConstructor).not.toHaveBeenCalled()
  })

  it('builds the pool from the RESOLVED identity (document wins over env), once', async () => {
    resolveCoreIdentity.mockResolvedValue({ userPoolId: 'doc-pool', clientId: 'doc-client' })
    getCurrentUser.mockReturnValue(null)
    const { getCurrentSession } = await loadAuth()

    await getCurrentSession()
    await getCurrentSession()

    expect(poolConstructor).toHaveBeenCalledTimes(1)
    expect(poolConstructor).toHaveBeenCalledWith({ UserPoolId: 'doc-pool', ClientId: 'doc-client' })
  })

  it('getCurrentSession resolves null (no crash) when no identity is resolvable', async () => {
    resolveCoreIdentity.mockResolvedValue({ userPoolId: '', clientId: '' })
    const { getCurrentSession } = await loadAuth()
    await expect(getCurrentSession()).resolves.toBeNull()
    expect(poolConstructor).not.toHaveBeenCalled()
  })

  it('signIn rejects with a clear error when no identity is available', async () => {
    resolveCoreIdentity.mockResolvedValue({ userPoolId: '', clientId: '' })
    const { signIn } = await loadAuth()
    await expect(signIn('u', 'p')).rejects.toThrow(/identity is unavailable/i)
  })
})
