import { describe, expect, it, vi, afterEach } from 'vitest'
import { ApiError, createApiClient, extractErrorMessage } from './api-client'

/**
 * A backend's error body is JSON like `{"detail": "..."}`. Throwing the whole
 * body as the message rendered `{"detail":"Internal Server Error"}` at the user
 * in a course player (tabsii-lms#13) and `{"detail":"Administrator access
 * required"}` where a user list belonged (biffo-template#1107). The API is
 * behaving; the presentation is not.
 *
 * These mirror `services/api/tests/test_core_client.py::TestExtractDetail`
 * case for case, because the two layers solve the same problem and drifting
 * apart would make neither reasonable about.
 */
describe('extractErrorMessage', () => {
  it('unwraps a JSON detail body', () => {
    expect(extractErrorMessage('{"detail":"Internal Server Error"}', 'Server Error')).toBe(
      'Internal Server Error',
    )
  })

  it('falls back to the raw text when the body is not JSON', () => {
    expect(extractErrorMessage('<html>Bad Gateway</html>', 'Bad Gateway')).toBe(
      '<html>Bad Gateway</html>',
    )
  })

  it('falls back to the raw text when the JSON has no detail key', () => {
    expect(extractErrorMessage('{"message":"nope"}', 'Bad Request')).toBe('{"message":"nope"}')
  })

  it('falls back to the raw text when detail is not a string', () => {
    const body = '{"detail":[{"loc":["body","x"],"msg":"bad"}]}'
    expect(extractErrorMessage(body, 'Unprocessable Entity')).toBe(body)
  })

  it('uses the status text when the body is empty', () => {
    expect(extractErrorMessage('', 'Internal Server Error')).toBe('Internal Server Error')
  })
})

describe('createApiClient error handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws an ApiError carrying the message, not the wire format', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('{"detail":"Internal Server Error"}'),
      }),
    )

    const api = createApiClient(() => 'token')
    await expect(api.get('/api/v1/courses')).rejects.toThrow(
      new ApiError(500, 'Internal Server Error'),
    )
  })
})

/**
 * An expired id token is not an error the user can act on — it is a renewal
 * this app already knows how to perform, and did not (tabsii-lms#3).
 *
 * The observed failure: after ~an hour an authoring session's next action
 * rendered `{"message":"Unauthorized"}` in red in the page. That body is API
 * Gateway's, produced by the JWT authorizer before the request ever reached the
 * app, so `extractErrorMessage` has no `detail` to unwrap and correctly falls
 * back to the raw text — the message layer was working exactly as designed on an
 * input it was never given a chance to improve. Meanwhile a usable refresh
 * token sat in localStorage, and reloading the page renewed silently.
 *
 * Every assertion below is on observable behaviour rather than on an exported
 * constant, so each one fails against the unfixed client for the reason the
 * reporter saw rather than on a missing import.
 */
describe('createApiClient session renewal', () => {
  const GATEWAY_401 = '{"message":"Unauthorized"}'

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function ok(body: unknown) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }
  }

  function unauthorized(body = GATEWAY_401) {
    return {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve(body),
    }
  }

  /**
   * Answers on the token it is given rather than on call count, so a retry that
   * re-sends the stale token is a failed assertion rather than a passing one.
   */
  function fetchAcceptingOnly(freshToken: string, body: unknown = { items: [] }) {
    return vi.fn((_url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>
      return Promise.resolve(
        headers['Authorization'] === `Bearer ${freshToken}` ? ok(body) : unauthorized(),
      )
    })
  }

  it('renews the session and retries once, so the call succeeds', async () => {
    const fetchMock = fetchAcceptingOnly('fresh', { items: ['course'] })
    vi.stubGlobal('fetch', fetchMock)
    const refresh = vi.fn(() => Promise.resolve<string | null>('fresh'))

    const api = createApiClient(() => 'expired', refresh)

    await expect(api.get('/api/v1/courses')).resolves.toEqual({ items: ['course'] })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries with the refreshed token, never the one that was rejected', async () => {
    const fetchMock = fetchAcceptingOnly('fresh')
    vi.stubGlobal('fetch', fetchMock)

    // The shape every caller actually uses: `() => token` closes over React
    // state, so it still returns the expired token after a renewal. A retry
    // that re-reads it would send the same rejected credential.
    const api = createApiClient(
      () => 'expired',
      () => Promise.resolve('fresh'),
    )
    await api.get('/api/v1/courses')

    const sent = fetchMock.mock.calls.map(
      ([, init]) => ((init.headers ?? {}) as Record<string, string>)['Authorization'],
    )
    expect(sent).toEqual(['Bearer expired', 'Bearer fresh'])
  })

  it('renews once for concurrent 401s rather than once per caller', async () => {
    vi.stubGlobal('fetch', fetchAcceptingOnly('fresh'))
    let resolveRefresh: (token: string) => void = () => {}
    const refresh = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRefresh = resolve
        }),
    )

    const api = createApiClient(() => 'expired', refresh)
    const inFlight = Promise.all([
      api.get('/api/v1/courses'),
      api.get('/api/v1/modules'),
      api.get('/api/v1/learners'),
    ])
    // Let all three reach their 401 before the single refresh settles.
    await Promise.resolve()
    resolveRefresh('fresh')
    await inFlight

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('surfaces an actionable sentence, not API Gateway body, when renewal fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorized()))

    const api = createApiClient(
      () => 'expired',
      () => Promise.resolve(null),
    )
    const error = await api.get('/api/v1/courses').then(
      () => {
        throw new Error('expected the request to reject')
      },
      (e: unknown) => e as ApiError,
    )

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(401)
    expect(error.message).not.toContain('Unauthorized"')
    expect(error.message).toBe(
      'Your session has expired. Reload the page to sign in again, then retry that action.',
    )
  })

  it('does not retry in a loop when the renewed token is also rejected', async () => {
    const fetchMock = vi.fn().mockResolvedValue(unauthorized())
    vi.stubGlobal('fetch', fetchMock)

    const api = createApiClient(
      () => 'expired',
      () => Promise.resolve('also-stale'),
    )

    await expect(api.get('/api/v1/courses')).rejects.toThrow(/session has expired/i)
    // The first attempt and exactly one retry. A revoked session must not spin.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats a renewal that hands back the same token as no renewal at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(unauthorized())
    vi.stubGlobal('fetch', fetchMock)

    const api = createApiClient(
      () => 'expired',
      () => Promise.resolve('expired'),
    )

    await expect(api.get('/api/v1/courses')).rejects.toThrow(/session has expired/i)
    // Re-sending a credential the gateway just rejected cannot succeed, so the
    // retry is skipped rather than spent.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports the expiry sentence when the renewal itself throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorized()))

    const api = createApiClient(
      () => 'expired',
      () => Promise.reject(new Error('network down')),
    )

    // The Cognito failure is plumbing the user cannot act on; what they can act
    // on is signing in again.
    await expect(api.get('/api/v1/courses')).rejects.toThrow(/session has expired/i)
  })

  it('keeps a backend 401 that explains itself, rather than overwriting it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(unauthorized('{"detail":"Token issued for another tenant"}')),
    )

    const api = createApiClient(
      () => 'expired',
      () => Promise.resolve(null),
    )

    // Same reasoning as extractErrorMessage's: never hide information the
    // caller already had. A `detail` is the product's own voice already.
    await expect(api.get('/api/v1/courses')).rejects.toThrow('Token issued for another tenant')
  })

  it('renews for a mutating verb too, and retries the body', async () => {
    const fetchMock = fetchAcceptingOnly('fresh', { id: 'c1' })
    vi.stubGlobal('fetch', fetchMock)

    const api = createApiClient(
      () => 'expired',
      () => Promise.resolve('fresh'),
    )
    await expect(api.post('/api/v1/courses', { title: 'New' })).resolves.toEqual({ id: 'c1' })

    const [, retry] = fetchMock.mock.calls
    expect(retry[1].method).toBe('POST')
    expect(retry[1].body).toBe(JSON.stringify({ title: 'New' }))
  })

  it('leaves a non-401 failure entirely alone', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: () => Promise.resolve('{"detail":"Administrator access required"}'),
    })
    vi.stubGlobal('fetch', fetchMock)
    const refresh = vi.fn(() => Promise.resolve<string | null>('fresh'))

    const api = createApiClient(() => 'token', refresh)

    await expect(api.get('/api/v1/users')).rejects.toThrow('Administrator access required')
    expect(refresh).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
