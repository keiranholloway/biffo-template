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

// The env vars are the TRANSITIONAL fallback (#403 Stage 3 removes them). The
// document is now the preferred source, so most tests set env AND control
// `fetch` to prove which one wins.
function configureCognitoEnv() {
  vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_USER_POOL_ID', 'us-east-1_TESTPOOL')
  vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_CLIENT_ID', 'testclientid')
}

// A `fetch` returning a valid identity document. The ids differ from the env
// values on purpose so a test can prove the DOCUMENT wins over baked env.
function mockFetchDocument(overrides: Record<string, unknown> = {}) {
  const body = {
    userPoolId: 'us-east-1_DOCPOOL',
    clientId: 'docclientid',
    region: 'us-east-1',
    ...overrides,
  }
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  }) as unknown as typeof fetch
}

// A `fetch` that rejects (network error) — drives the env fallback path.
function mockFetchUnreachable() {
  global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
}

// Each test re-imports the module fresh: both the pool (auth.ts) and the
// resolved-identity Promise (identity.ts) are memoised at module scope, so a
// module instance left over from a previous test would carry that test's
// document/env into the next one.
async function loadAuth() {
  vi.resetModules()
  return await import('@/lib/auth')
}

describe('getCurrentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configureCognitoEnv()
    // Default: document unreachable, so these behaviour tests build the pool
    // from the env fallback (us-east-1_TESTPOOL / testclientid) exactly as the
    // pre-runtime version did.
    mockFetchUnreachable()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
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

// The core now publishes its Cognito coordinates at runtime; the sibling
// prefers that document over its baked env vars (#403/#400). These tests pin
// which source wins under each condition.
describe('runtime core identity resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('builds the pool from the published document, not from env', async () => {
    // Env is set to DIFFERENT values so a pass proves the document won.
    configureCognitoEnv()
    mockFetchDocument()
    const { getCurrentSession } = await loadAuth()
    getCurrentUser.mockReturnValue(null)

    await getCurrentSession()

    expect(global.fetch).toHaveBeenCalledWith('/.well-known/biffo-identity.json', {
      cache: 'no-store',
    })
    expect(poolConstructor).toHaveBeenCalledWith({
      UserPoolId: 'us-east-1_DOCPOOL',
      ClientId: 'docclientid',
    })
  })

  it('falls back to env and warns when the document is unreachable', async () => {
    configureCognitoEnv()
    mockFetchUnreachable()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { getCurrentSession } = await loadAuth()
    getCurrentUser.mockReturnValue(null)

    await getCurrentSession()

    expect(poolConstructor).toHaveBeenCalledWith({
      UserPoolId: 'us-east-1_TESTPOOL',
      ClientId: 'testclientid',
    })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('DEGRADED')
  })

  it('falls back to env when the document is served but missing ids', async () => {
    configureCognitoEnv()
    // ok:true but the body lacks a clientId — treated as unusable.
    mockFetchDocument({ clientId: '' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { getCurrentSession } = await loadAuth()
    getCurrentUser.mockReturnValue(null)

    await getCurrentSession()

    expect(poolConstructor).toHaveBeenCalledWith({
      UserPoolId: 'us-east-1_TESTPOOL',
      ClientId: 'testclientid',
    })
    expect(warn).toHaveBeenCalledOnce()
  })

  it('resolves null and never constructs the pool when both document and env are absent', async () => {
    vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_USER_POOL_ID', '')
    vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_CLIENT_ID', '')
    mockFetchUnreachable()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { getCurrentSession } = await loadAuth()

    await expect(getCurrentSession()).resolves.toBeNull()
    expect(poolConstructor).not.toHaveBeenCalled()
    // No document AND no env is an unconfigured build, not degradation — quiet.
    expect(warn).not.toHaveBeenCalled()
  })

  it('fetches the document at most once across multiple session reads (memoised)', async () => {
    configureCognitoEnv()
    mockFetchDocument()
    const { getCurrentSession } = await loadAuth()
    getCurrentUser.mockReturnValue(null)

    await getCurrentSession()
    await getCurrentSession()
    await getCurrentSession()

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(poolConstructor).toHaveBeenCalledTimes(1)
  })
})

// The CognitoUserPool constructor throws ("Both UserPoolId and ClientId are
// required") when either value is missing, and `next build` prerenders `/` in
// Node — which imports this module. Building the pool at module scope therefore
// made the skeleton un-buildable without a resolvable identity in scope. These
// tests pin that shut.
describe('lazy pool construction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchUnreachable()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('does not construct the pool merely by importing the module', async () => {
    configureCognitoEnv()
    await loadAuth()
    expect(poolConstructor).not.toHaveBeenCalled()
  })

  it('imports cleanly with no Cognito env vars set and no fetch available', async () => {
    vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_USER_POOL_ID', '')
    vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_CLIENT_ID', '')
    // Simulate `next build` prerendering `/` in Node with no fetch in scope.
    const originalFetch = global.fetch
    // @ts-expect-error deliberately remove fetch to mimic the Node prerender.
    delete global.fetch
    try {
      await expect(loadAuth()).resolves.toBeDefined()
      expect(poolConstructor).not.toHaveBeenCalled()
    } finally {
      global.fetch = originalFetch
    }
  })

  it('resolves null instead of throwing when Cognito env vars are absent', async () => {
    vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_USER_POOL_ID', '')
    vi.stubEnv('NEXT_PUBLIC_CORE_COGNITO_CLIENT_ID', '')
    const { getCurrentSession } = await loadAuth()
    await expect(getCurrentSession()).resolves.toBeNull()
    expect(poolConstructor).not.toHaveBeenCalled()
  })

  it('constructs the pool once, on first session read, from the env fallback', async () => {
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
//
// resolveCoreIdentity lives in identity.ts, deliberately NOT re-exported here:
// auth.ts's surface stays exactly one export.
describe('sibling auth surface', () => {
  it('exposes only session reading — no sign-in/sign-out machinery', async () => {
    const authModule = await loadAuth()
    expect(Object.keys(authModule).sort()).toEqual(['getCurrentSession'])
  })
})
