/**
 * Role-based routing after login.
 *
 * Given a user's identity, group memberships, and an optional return_to
 * destination, determine where they should be redirected after authentication.
 *
 * Rules are evaluated in order (first match wins):
 * 1. A valid returnTo provided by the caller -> returnTo
 * 2. User is in the 'admin' Cognito group -> '/admin/'
 * 3. User is marked as a platform admin -> '/crm/'
 * 4. User has any role with scope_level 'tenant'|'brand'|'region' -> '/crm/'
 * 5. User has any role with scope_level 'unit' -> '/lms/'
 * 6. User has marketplace_role set and no roles -> '/marketplace/'
 * 7. Otherwise -> '/login/no-access/'
 *
 * Rule 5 used to send unit-scoped users to '/crm/' as well. That was recorded
 * as interim when it shipped: a unit worker doing onboarding and training is
 * not doing customer relationship management, and the arrival of a training
 * surface was named as the trigger to move them off it (ADR-0100 / ADR-0101).
 * '/crm/' stays reachable — this is a landing destination, not an entitlement,
 * and the database decides what either surface will actually serve.
 */

import { ADMIN_GROUP } from './cognito-groups'

export interface WhoamiRole {
  role: string
  scope_level: string
  tenant_id?: string
  brand_id?: string
  region_id?: string
  unit_id?: string
  franchisee_id?: string
}

export interface WhoamiResponse {
  sub: string
  email: string
  username: string
  user_id: string
  is_platform_admin: boolean
  permissions: string[]
  marketplace_role: string | null
  roles: WhoamiRole[]
}

/**
 * Determine the post-login destination for a user based on their identity,
 * group memberships, and an optional return_to.
 *
 * @param whoami User identity and roles from GET /api/v1/whoami
 * @param groups Cognito groups from the ID token's 'cognito:groups' claim
 * @param returnTo Optional return destination (already sanitised by caller)
 * @returns The destination URL
 */
export function resolveDestination(
  whoami: WhoamiResponse,
  groups: string[] | undefined,
  returnTo: string | null,
): string {
  // Rule 1: a valid returnTo (already sanitised by the caller)
  if (returnTo) {
    return returnTo
  }

  // Rule 2: groups includes 'admin'. The same constant `AuthGuard` gates
  // /admin/ on (#1104) — routing someone to a destination that will then
  // refuse them is the failure the two rules exist to avoid together.
  if (groups?.includes(ADMIN_GROUP)) {
    return '/admin/'
  }

  // Rule 3: whoami.is_platform_admin === true
  if (whoami.is_platform_admin) {
    return '/crm/'
  }

  // Rule 4: any role whose scope_level is 'tenant'|'brand'|'region'
  if (whoami.roles.some((r) => ['tenant', 'brand', 'region'].includes(r.scope_level))) {
    return '/crm/'
  }

  // Rule 5: any role whose scope_level is 'unit'
  if (whoami.roles.some((r) => r.scope_level === 'unit')) {
    return '/lms/'
  }

  // Rule 6: whoami.marketplace_role is set and there are no roles
  if (whoami.marketplace_role && whoami.roles.length === 0) {
    return '/marketplace/'
  }

  // Rule 7: otherwise
  return '/login/no-access/'
}
