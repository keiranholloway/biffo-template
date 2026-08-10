import { ApiError, type createApiClient } from './api-client'
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

/**
 * The identity that can be derived from the verified ID token alone, for a
 * deployment whose API does not serve `/api/v1/whoami`.
 *
 * ## Why this exists
 *
 * This portal is template-owned and ships to every instance, but it is deployed
 * on the instance's own cadence — so a portal carrying a new API contract can
 * reach an instance whose API has not been upgraded yet. That happened: the
 * login page began calling `/api/v1/whoami` while only one instance's product
 * domain served it, and everywhere else FastAPI answered 404. Sign-in succeeded
 * at Cognito and the user was still returned to the form, which is
 * indistinguishable from a rejected password. Core serves the route now
 * (`services/api/src/api/routers/whoami.py`), which is the real fix; this is
 * what keeps the *gap between deploys* from locking admins out of their own
 * instance.
 *
 * ## It grants nothing
 *
 * Every field is either read from the verified token or left empty. In
 * particular `is_platform_admin` is `false` and `roles`/`permissions` are empty
 * regardless of what the caller might actually hold — so the only rule in
 * `resolveDestination` this can satisfy is rule 2, `cognito:groups` containing
 * `admin`, which comes from the signed token and which `AuthGuard` re-checks at
 * the destination anyway. A caller who would have been routed by a scoped role
 * lands on no-access instead: degraded, but honest, and never an escalation.
 */
export function whoamiFromClaims(claims: Record<string, unknown>): WhoamiResponse {
  const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
  return {
    sub: asString(claims['sub']),
    email: asString(claims['email']),
    username: asString(claims['cognito:username']),
    user_id: '',
    is_platform_admin: false,
    permissions: [],
    marketplace_role: null,
    roles: [],
  }
}

/**
 * The caller's identity, degrading to {@link whoamiFromClaims} when this
 * deployment's API does not serve the whoami contract.
 *
 * **Only a 404 falls back**, because only a 404 means "this route does not
 * exist here". A 401, a 403, a 500 or a network failure are all transient or
 * genuine refusals: swallowing them would route a real admin to no-access on a
 * blip and make a broken API look like a permissions problem. They propagate,
 * and the caller reports them.
 */
export async function resolveWhoami(
  client: Pick<Client, 'get'>,
  claims: Record<string, unknown>,
): Promise<WhoamiResponse> {
  try {
    return await fetchWhoami(client)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      console.warn(
        '[login] /api/v1/whoami is not served by this deployment — routing on the ' +
          "ID token's groups alone. Scoped roles cannot be seen, so a non-admin will " +
          'be sent to no-access. Upgrade the instance API to restore full routing.',
      )
      return whoamiFromClaims(claims)
    }
    throw err
  }
}
