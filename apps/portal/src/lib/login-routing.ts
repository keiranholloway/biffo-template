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
 */

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

  // Rule 2: groups includes 'admin'
  if (groups?.includes('admin')) {
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

  // Rule 5: any role whose scope_level is 'unit' -> the LMS.
  //
  // This returned '/crm/' until tabsii's 0013-lms-v1 M12, and tabsii ADR-0100
  // said so at the time: the unit surface was built in the CRM as an explicitly
  // interim arrangement, because unit-scoped users could not otherwise sign in
  // to anything useful, and "the arrival of the LMS is the trigger to move
  // unit-scoped users onto a dedicated surface". A unit worker doing training is
  // not doing customer relationship management.
  //
  // Note this whole table names instance surfaces ('/crm/', '/marketplace/',
  // now '/lms/') from template-owned code, which is why the change had to be
  // made here rather than in the instance that wanted it. That is a real seam
  // problem and it predates this change — see the issue raised alongside it.
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
