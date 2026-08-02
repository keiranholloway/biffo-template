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
