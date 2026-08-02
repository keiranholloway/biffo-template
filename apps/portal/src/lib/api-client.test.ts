import { describe, expect, it, vi, afterEach } from 'vitest'
import { ApiError, createApiClient, extractErrorMessage } from './api-client'

/**
 * #1107 — the portal rendered the API's raw JSON body as the error message, so
 * a non-admin opening /admin/users/ saw, verbatim, where the user list belonged:
 *
 *     {"detail":"Administrator access required"}
 *
 * The refusal is a well-formed `403 {"detail": "..."}`. The API was behaving;
 * the presentation was not. Fixed in the fetch wrapper so every page inherits
 * it rather than each one improvising.
 *
 * These mirror `services/api/tests/test_core_client.py::TestExtractDetail` in
 * the siblings — same cases, same fallbacks — because the two layers solve the
 * same problem and drifting apart would make neither reasonable about.
 */
describe('extractErrorMessage', () => {
  it('unwraps a JSON detail body', () => {
    expect(extractErrorMessage('{"detail":"Administrator access required"}', 'Forbidden')).toBe(
      'Administrator access required',
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
    // FastAPI's own 422 shape: `detail` is a list of field errors. Extracting a
    // non-string would move the problem rather than fix it, so this is left
    // exactly like the "not JSON" case — the same call the Python twin makes.
    const body = '{"detail":[{"loc":["body","x"],"msg":"bad"}]}'
    expect(extractErrorMessage(body, 'Unprocessable Entity')).toBe(body)
  })

  it('uses the status text when the body is empty', () => {
    // The one addition over the Python version: a browser rendering '' shows
    // the user nothing at all.
    expect(extractErrorMessage('', 'Internal Server Error')).toBe('Internal Server Error')
  })

  it('uses the status text when detail is an empty string', () => {
    expect(extractErrorMessage('{"detail":""}', 'Forbidden')).toBe('Forbidden')
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
        status: 403,
        statusText: 'Forbidden',
        text: () => Promise.resolve('{"detail":"Administrator access required"}'),
      }),
    )

    const api = createApiClient(() => 'token')
    await expect(api.get('/api/v1/admin/users')).rejects.toThrow(
      new ApiError(403, 'Administrator access required'),
    )
  })

  it('reports the status text when the body cannot be read at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: () => Promise.reject(new Error('stream closed')),
      }),
    )

    const api = createApiClient(() => 'token')
    await expect(api.get('/x')).rejects.toThrow(new ApiError(502, 'Bad Gateway'))
  })
})
