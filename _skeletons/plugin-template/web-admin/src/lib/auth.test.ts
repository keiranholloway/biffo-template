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

/**
 * What the real library hands back: an IMMUTABLE snapshot. `getIdToken()` on a
 * `CognitoUserSession` returns the same `CognitoIdToken` forever, so the JWT
 * inside one of these never changes — which is the whole reason a caller must
 * not hold on to it, and the reason `getFreshIdToken` re-reads storage.
 */
function session(jwt: string) {
  const idToken = { getJwtToken: () => jwt, payload: {} }
  return { isValid: () => true, getIdToken: () => idToken }
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

// Folded up from biffo-plugin-ideation's own copy of this file (biffo-template#1564).
//
// `filesIfPresent` maps that repo's `web/src/lib/auth.test.ts` at THIS file, and
// #1546 added the mapping in the same commit that created this file — so the
// canonical copy has been a strict SUBSET of the one repo already holding that
// path, and the next sync round would have deleted every assertion below.
// AGENTS.md section 9 ("Reconcile before you distribute") says to fold the fixes
// upstream first, which is what this block is: the same four properties, restated
// in this file's `loadAuth()` idiom so they hold against the in-flight-memoised
// pool rather than the settled-value one they were written for.
//
// The invariant they guard is the one `getFreshIdToken`'s own docstring argues at
// length and nothing here tested: a `CognitoUserSession` is an immutable value
// object, so a caller that snapshots the JWT sends a frozen token that 401s for
// the life of the page once it lapses (biffo-plugin-ideation#69).
describe('getFreshIdToken', () => {
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

  it('re-resolves through the pool on every call, so a refreshed token replaces a lapsed one', async () => {
    // `stored` stands for what localStorage holds. The library rotates it when
    // the cached ID token expires and the refresh token buys a new one — the
    // caller sees that only if it asks again.
    let stored = session('jwt-before-refresh')
    getCurrentUser.mockReturnValue({
      getSession: (cb: (e: Error | null, s: unknown) => void) => cb(null, stored),
    })
    const { getFreshIdToken } = await loadAuth()

    expect(await getFreshIdToken()).toBe('jwt-before-refresh')

    stored = session('jwt-after-refresh')

    expect(await getFreshIdToken()).toBe('jwt-after-refresh')
    // Two resolutions, not one memoised answer. The POOL is memoised; the
    // session read deliberately is not.
    expect(getCurrentUser).toHaveBeenCalledTimes(2)
    expect(poolConstructor).toHaveBeenCalledTimes(1)
  })

  it('is null when there is no session, rather than throwing', async () => {
    getCurrentUser.mockReturnValue(null)
    const { getFreshIdToken } = await loadAuth()
    await expect(getFreshIdToken()).resolves.toBeNull()
  })

  it('is null when the pool cannot be resolved (identity document unreachable)', async () => {
    resolveCoreIdentity.mockResolvedValue(null)
    const { getFreshIdToken } = await loadAuth()
    await expect(getFreshIdToken()).resolves.toBeNull()
    expect(getCurrentUser).not.toHaveBeenCalled()
  })

  it('only ever asks the pool built from the runtime identity document', async () => {
    // The claim biffo-plugin-ideation#70 rests on and #69 disputed: the pool is
    // constructed from the resolved identity and the library scopes every storage
    // read by that Client ID, so no other pool's credentials can be reached here.
    getCurrentUser.mockReturnValue({
      getSession: (cb: (e: Error | null, s: unknown) => void) => cb(null, session('jwt')),
    })
    const { getFreshIdToken } = await loadAuth()

    await getFreshIdToken()

    expect(resolveCoreIdentity).toHaveBeenCalled()
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
