import type { createApiClient } from './api-client'
import type { WhoamiResponse } from './login-routing'

type Client = ReturnType<typeof createApiClient>

/**
 * Fetch the current user's identity and roles.
 *
 * @param client API client configured with the ID token
 * @returns User identity, permissions, and roles
 */
export function fetchWhoami(client: Pick<Client, 'get'>): Promise<WhoamiResponse> {
  return client.get<WhoamiResponse>('/api/v1/whoami')
}
