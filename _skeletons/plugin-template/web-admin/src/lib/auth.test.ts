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

const resolveCoreIdentity = vi.fn()
vi.mock('./identity', () => ({ resolveCoreIdentity }))

vi.mock('./cognito-hygiene', () => ({ pruneForeignCognitoCredentials: vi.fn() }))

// Fresh module each test: the pool is memoised at module scope.
async function loadAuth() {
  vi.resetModules()
  return await import('./auth')
}

describe('getCurrentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveCoreIdentity.mockResolvedValue({
      userPoolId: 'us-east-1_DOCPOOL',
      clientId: 'docclientid',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when no user is stored in the shared localStorage session', async () => {
    const { getCurrentSession } = await loadAuth()
    getCurrentUser.mockReturnValue(null)
    await expect(getCurrentSession()).resolves.toBeNull()
  })

  it('returns null when no identity is resolvable', async () => {
    resolveCoreIdentity.mockResolvedValue(null)
    const { getCurrentSession } = await loadAuth()
    await expect(getCurrentSession()).resolves.toBeNull()
    expect(poolConstructor).not.toHaveBeenCalled()
  })

  it('builds the pool once across multiple sequential session reads (memoised)', async () => {
    const { getCurrentSession } = await loadAuth()
    getCurrentUser.mockReturnValue(null)

    await getCurrentSession()
    await getCurrentSession()

    expect(poolConstructor).toHaveBeenCalledTimes(1)
    expect(poolConstructor).toHaveBeenCalledWith({
      UserPoolId: 'us-east-1_DOCPOOL',
      ClientId: 'docclientid',
    })
  })
})

// biffo-plugin-marketing#55: the pool used to be memoised on the SETTLED value,
// so concurrent callers that started before the first resolution completed each
// ran an independent resolution (including pruneForeignCognitoCredentials()'s
// localStorage scan-and-delete). campaign-studio's Pipeline.tsx/Results.tsx now
// fire several concurrent getArtefact calls on one mount, which is what made
// this newly load-bearing rather than academic.
describe('concurrent callers share one pool resolution (biffo-plugin-marketing#55)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves the pool exactly once when two callers race before it settles', async () => {
    // A manually-resolved identity lookup guarantees BOTH calls are in flight
    // before resolution, rather than relying on incidental microtask timing.
    let resolveIdentity!: (value: { userPoolId: string; clientId: string }) => void
    resolveCoreIdentity.mockReturnValue(
      new Promise((resolve) => {
        resolveIdentity = resolve
      }),
    )
    const { getCurrentSession } = await loadAuth()
    getCurrentUser.mockReturnValue(null)

    const first = getCurrentSession()
    const second = getCurrentSession()

    resolveIdentity({ userPoolId: 'us-east-1_DOCPOOL', clientId: 'docclientid' })

    await Promise.all([first, second])

    // The regression this guards: without in-flight memoisation, both callers
    // independently reach the pool constructor before either could observe
    // the other's result.
    expect(poolConstructor).toHaveBeenCalledTimes(1)
  })

  it('does not cache a rejection — a later call gets a fresh attempt', async () => {
    resolveCoreIdentity.mockResolvedValue({
      userPoolId: 'us-east-1_DOCPOOL',
      clientId: 'docclientid',
    })
    // Simulate a transient failure building the pool itself (identity
    // resolution here never rejects — it catches internally — but the pool
    // construction step must still not be able to poison the memo forever).
    poolConstructor.mockImplementationOnce(() => {
      throw new Error('transient pool construction failure')
    })
    const { getCurrentSession } = await loadAuth()
    getCurrentUser.mockReturnValue(null)

    await expect(getCurrentSession()).rejects.toThrow('transient pool construction failure')

    // Retried, not replayed: the second call gets its own attempt and succeeds.
    await expect(getCurrentSession()).resolves.toBeNull()
    expect(poolConstructor).toHaveBeenCalledTimes(2)
  })
})
