// Calls THIS sibling's own backend only (never the core's database directly —
// ADR-0002/ADR-0007). If this sibling needs core-owned data, its own backend
// is responsible for calling the core API server-side (see
// services/api/src/api/core_client.py) — the frontend never talks to the
// core API directly.
const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? ''

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * The message a person should see for a failed request — not the wire format.
 *
 * A Biffo backend's errors are JSON like `{"detail": "..."}`. Throwing the
 * whole body as the message renders `{"detail":"Internal Server Error"}` at
 * the user (tabsii-lms#13, biffo-template#1107) — the API is behaving, the
 * presentation is not.
 *
 * This is the browser-side twin of `_extract_detail` in this repo's
 * `services/api/src/api/core_client.py`, which solves the identical problem
 * server-side, and it keeps that function's reasoning deliberately:
 *
 * - **Parsed, never assumed.** A non-JSON body (a proxy timeout page, a
 *   CloudFront error), or JSON with no `detail`, falls back to the raw text
 *   unchanged — so this can never hide information the caller had before.
 * - **A non-string `detail` also falls back.** FastAPI's own 422 makes
 *   `detail` a list of field errors; picking something out of it would just
 *   move the problem rather than fix it.
 *
 * The one addition over the Python version: an empty body yields the HTTP
 * status text, because a browser rendering `''` shows the user nothing at all.
 */
export function extractErrorMessage(body: string, statusText: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body || statusText
  }
  if (typeof parsed === 'object' && parsed !== null && 'detail' in parsed) {
    const { detail } = parsed
    if (typeof detail === 'string') return detail || statusText
  }
  return body || statusText
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ApiError(res.status, extractErrorMessage(body, res.statusText))
  }
  return res.json() as Promise<T>
}

export function createApiClient(getIdToken: () => string | null) {
  function authHeaders(): HeadersInit {
    const token = getIdToken()
    return {
      'Content-Type': 'application/json',
      ...(token != null ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  return {
    get: <T>(path: string): Promise<T> =>
      fetch(`${API_URL}${path}`, { headers: authHeaders() }).then((r) => handleResponse<T>(r)),

    post: <T>(path: string, body: unknown): Promise<T> =>
      fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      }).then((r) => handleResponse<T>(r)),

    put: <T>(path: string, body: unknown): Promise<T> =>
      fetch(`${API_URL}${path}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(body),
      }).then((r) => handleResponse<T>(r)),

    // Folded in from tabsii-crm, which had added it locally. It costs a sibling
    // that never calls it nothing, and leaving it out would mean this file
    // could never be distributed without destroying crm's copy.
    patch: <T>(path: string, body: unknown): Promise<T> =>
      fetch(`${API_URL}${path}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(body),
      }).then((r) => handleResponse<T>(r)),

    delete: <T>(path: string): Promise<T> =>
      fetch(`${API_URL}${path}`, { method: 'DELETE', headers: authHeaders() }).then((r) =>
        handleResponse<T>(r),
      ),
  }
}
