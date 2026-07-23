import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

function docResponse(body: unknown, ok = true): Response {
  return { ok, json: () => Promise.resolve(body) } as Response
}

// Fresh module each test: resolveCoreIdentity memoises for the page's lifetime,
// so a leftover cache would carry one test's document into the next.
async function loadIdentity() {
  vi.resetModules()
  return await import('./identity')
}

describe('resolveCoreIdentity (#403)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('resolves from the published document, ignoring the baked env values', async () => {
    vi.stubEnv('NEXT_PUBLIC_COGNITO_USER_POOL_ID', 'env-pool')
    vi.stubEnv('NEXT_PUBLIC_COGNITO_CLIENT_ID', 'env-client')
    fetchMock.mockResolvedValue(
      docResponse({ userPoolId: 'doc-pool', clientId: 'doc-client', region: 'eu-west-1' }),
    )
    const { resolveCoreIdentity } = await loadIdentity()
    await expect(resolveCoreIdentity()).resolves.toMatchObject({
      userPoolId: 'doc-pool',
      clientId: 'doc-client',
      region: 'eu-west-1',
    })
    expect(fetchMock).toHaveBeenCalledWith('/.well-known/biffo-identity.json', {
      cache: 'no-store',
    })
  })

  it('fetches at most once across calls (memoised)', async () => {
    fetchMock.mockResolvedValue(docResponse({ userPoolId: 'p', clientId: 'c' }))
    const { resolveCoreIdentity } = await loadIdentity()
    await resolveCoreIdentity()
    await resolveCoreIdentity()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to the baked env values when the document is unreachable, and warns (degraded)', async () => {
    vi.stubEnv('NEXT_PUBLIC_COGNITO_USER_POOL_ID', 'env-pool')
    vi.stubEnv('NEXT_PUBLIC_COGNITO_CLIENT_ID', 'env-client')
    fetchMock.mockRejectedValue(new Error('network down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { resolveCoreIdentity } = await loadIdentity()
    await expect(resolveCoreIdentity()).resolves.toMatchObject({
      userPoolId: 'env-pool',
      clientId: 'env-client',
    })
    expect(warn).toHaveBeenCalledOnce()
  })

  it('falls back on a non-ok response, or one missing the ids', async () => {
    vi.stubEnv('NEXT_PUBLIC_COGNITO_USER_POOL_ID', 'env-pool')
    vi.stubEnv('NEXT_PUBLIC_COGNITO_CLIENT_ID', 'env-client')
    fetchMock.mockResolvedValue(docResponse({}, false))
    const { resolveCoreIdentity } = await loadIdentity()
    await expect(resolveCoreIdentity()).resolves.toMatchObject({
      userPoolId: 'env-pool',
      clientId: 'env-client',
    })
  })

  it('returns an empty identity WITHOUT warning when neither document nor env is available', async () => {
    // An unconfigured build is not a degradation — no false alarm.
    vi.stubEnv('NEXT_PUBLIC_COGNITO_USER_POOL_ID', '')
    vi.stubEnv('NEXT_PUBLIC_COGNITO_CLIENT_ID', '')
    fetchMock.mockRejectedValue(new Error('network down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { resolveCoreIdentity } = await loadIdentity()
    await expect(resolveCoreIdentity()).resolves.toMatchObject({ userPoolId: '', clientId: '' })
    expect(warn).not.toHaveBeenCalled()
  })
})
