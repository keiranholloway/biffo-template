import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  ApiError,
  createApiClient,
  extractErrorMessage,
  __resetRenewedTokenCacheForTests,
} from './api-client'

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

  // Renamed from "falls back to the raw text when detail is not a string" —
  // that name generalised a decision only ever made about a LIST `detail`
  // (biffo-template#1350). It is no longer true of every non-string detail: a
  // dict carrying a string `message` (below) now unwraps instead of falling
  // back. FastAPI's own 422 is the case this test still pins.
  it('falls back to the raw text when detail is a list (FastAPI 422 field errors)', () => {
    const body = '{"detail":[{"loc":["body","x"],"msg":"bad"}]}'
    expect(extractErrorMessage(body, 'Unprocessable Entity')).toBe(body)
  })

  // The browser-side twin of `_extract_detail`'s identical rule in
  // core_client.py. Core's generic CRUD layer answers an integrity error with
  // `{"detail": {"message": "...", "constraint": "..."}}`
  // (`routing/crud_handlers._integrity_error_response`); until this rule
  // existed here, that shape fell straight through to the raw JSON blob, even
  // in a sibling whose BFF had already unwrapped it server-side
  // (biffo-template#1350, tabsii-crm#272).
  it('unwraps a dict detail carrying a string message', () => {
    const body =
      '{"detail":{"message":"course c1 cannot be deleted: 3 enrolment(s) depend on it.","constraint":"fk_enrolments_course_id"}}'
    expect(extractErrorMessage(body, 'Conflict')).toBe(
      'course c1 cannot be deleted: 3 enrolment(s) depend on it.',
    )
  })

  // `constraint` is deliberately dropped, not appended, in EVERY case — a
  // database object name is schema reconnaissance (tabsii-platform#473) and
  // says nothing to the person reading the sentence. This asserts the drop
  // rather than just the unwrap above, so a future "helpfully" append would
  // fail here even if it left the previous test passing.
  it('drops constraint rather than appending it to the message', () => {
    const body = '{"detail":{"message":"cannot delete","constraint":"fk_enrolments_course_id"}}'
    const message = extractErrorMessage(body, 'Conflict')
    expect(message).toBe('cannot delete')
    expect(message).not.toContain('fk_enrolments_course_id')
  })

  // Only the declared `message` key is trusted. A dict `detail` with no
  // `message` is a shape nobody has declared, so it falls back to the raw
  // text — same posture as the list case above — rather than inventing a
  // summary that could hide information the caller had before.
  it('falls back to the raw text when a dict detail has no message', () => {
    const body = '{"detail":{"constraint":"fk_enrolments_course_id"}}'
    expect(extractErrorMessage(body, 'Conflict')).toBe(body)
  })

  it('uses the status text when the body is empty', () => {
    expect(extractErrorMessage('', 'Internal Server Error')).toBe('Internal Server Error')
  })
})

describe('createApiClient error handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    __resetRenewedTokenCacheForTests()
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
    __resetRenewedTokenCacheForTests()
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

  /**
   * Same shape as `fetchAcceptingOnly`, but for a scenario spanning more than
   * one session's fresh token — proving a later session is never let in on an
   * earlier session's renewed credential.
   */
  function fetchAcceptingAnyOf(freshTokens: string[], body: unknown = { items: [] }) {
    return vi.fn((_url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>
      const sent = headers['Authorization']
      const accepted = freshTokens.some((token) => sent === `Bearer ${token}`)
      return Promise.resolve(accepted ? ok(body) : unauthorized())
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

  /**
   * The claim this PR (biffo-template#1283) exists to prove, not the retry
   * behaviour #1277 already covers above. #1277 fixed the user-visible half —
   * the FIRST 401 after expiry renews and retries so the call still succeeds.
   * What it left is every LATER request on the same page: nothing wrote the
   * renewed token back to the state `getIdToken()` reads, so a second request
   * with the same stale closure paid the identical 401 + renew + retry cycle
   * all over again, for the rest of the page's life. Without the fix in this
   * PR, the second `api.get` below would fetch twice and renew a second time
   * — exactly like the first request did — rather than sending the renewed
   * token straight away.
   */
  it('sends the renewed token directly on a later request, and does not 401 again', async () => {
    const fetchMock = fetchAcceptingOnly('fresh')
    vi.stubGlobal('fetch', fetchMock)
    const refresh = vi.fn(() => Promise.resolve<string | null>('fresh'))

    // Every real caller passes `() => token` closing over React state that a
    // renewal outside React never updates — so this closure keeps returning
    // 'expired' for the rest of the page's life, exactly like the reporter's
    // hours-long authoring session.
    const api = createApiClient(() => 'expired', refresh)

    // First request: pays the full cycle, exactly as #1277 fixed it.
    await expect(api.get('/api/v1/courses')).resolves.toEqual({ items: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)

    // Second request: same client, same stale `getIdToken()` value. Assert
    // the actual claim — exactly ONE fetch, carrying the renewed token
    // directly, with no second 401 and no second renewal.
    fetchMock.mockClear()
    await expect(api.get('/api/v1/modules')).resolves.toEqual({ items: [] })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer fresh')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  /**
   * The hazard called out when this fix was scoped: a module-level cache is
   * shared mutable state, so sign-out — or a different user signing in, in
   * the same tab, which `tabsii-marketplace`'s public self-service flow makes
   * real — must not let the previous session's renewed token leak into the
   * next one. That would be a security defect, not a latency one.
   */
  it('does not leak a renewed token across sign-out to a different session', async () => {
    const fetchMock = fetchAcceptingAnyOf(['fresh-a', 'fresh-b'])
    vi.stubGlobal('fetch', fetchMock)

    let currentToken = 'expired-a'
    const refresh = vi.fn(() =>
      Promise.resolve<string | null>(currentToken === 'expired-a' ? 'fresh-a' : 'fresh-b'),
    )
    const api = createApiClient(() => currentToken, refresh)

    // User A's session: first call renews and retries; second call is served
    // straight from the cache (this is the behaviour under test above).
    await expect(api.get('/api/v1/courses')).resolves.toEqual({ items: [] })
    await expect(api.get('/api/v1/courses')).resolves.toEqual({ items: [] })
    expect(refresh).toHaveBeenCalledTimes(1)

    // Sign-out, then a DIFFERENT user signs in — a brand new stale token from
    // `getIdToken()`, simulating React state now belonging to a new session.
    currentToken = 'expired-b'
    const callsBeforeSwitch = fetchMock.mock.calls.length

    await expect(api.get('/api/v1/courses')).resolves.toEqual({ items: [] })

    const callsSinceSwitch = fetchMock.mock.calls.slice(callsBeforeSwitch)
    // If user A's cached token had leaked, this request would succeed on its
    // FIRST fetch by reusing 'fresh-a'. Instead it must pay its own renewal —
    // proof the new session's first request sent its OWN stale token, not the
    // previous session's cached fresh one.
    expect(callsSinceSwitch).toHaveLength(2)
    const firstAuthHeader = (callsSinceSwitch[0][1].headers as Record<string, string>)[
      'Authorization'
    ]
    expect(firstAuthHeader).toBe('Bearer expired-b')
    expect(refresh).toHaveBeenCalledTimes(2)
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
