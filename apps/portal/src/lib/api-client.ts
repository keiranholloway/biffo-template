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

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new ApiError(res.status, body)
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

    delete: <T>(path: string): Promise<T> =>
      fetch(`${API_URL}${path}`, { method: 'DELETE', headers: authHeaders() }).then((r) =>
        handleResponse<T>(r),
      ),
  }
}
