import type { createApiClient } from './api-client'

/**
 * A Cognito user as surfaced by the Core API's admin user-management endpoints
 * (`/api/v1/admin/users`). Identity and group membership are Cognito's — the
 * `cognito:groups` claim drives authorization (ADR-0004) — so these operations
 * manage Cognito, not DB rows.
 */
export interface AdminUser {
  username: string
  sub: string
  email: string
  status: string
  enabled: boolean
  groups: string[]
  created_at: string | null
  // Cognito attributes (identity source of truth)
  given_name: string | null
  family_name: string | null
  phone_number: string | null
  // DB-mirror-only profile fields — null until the mirror row exists
  organization_id: string | null
  organization_name: string | null
  job_role: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string | null
}

export interface AdminUserList {
  users: AdminUser[]
  next_token: string | null
}

export interface CreateUserRequest {
  email: string
  given_name: string
  family_name: string
  phone_number?: string | undefined
  groups?: string[] | undefined
  organization_id?: string | undefined
  job_role?: string | undefined
  address_line1?: string | undefined
  address_line2?: string | undefined
  city?: string | undefined
  region?: string | undefined
  postal_code?: string | undefined
  country?: string | undefined
}

/**
 * Edit an existing user (#633) — every field optional, and PATCH semantics
 * apply: omitting a field leaves it unchanged (unlike CreateUserRequest,
 * where every field describes the whole new user).
 */
export interface AdminUserUpdateRequest {
  given_name?: string | undefined
  family_name?: string | undefined
  phone_number?: string | undefined
  organization_id?: string | undefined
  job_role?: string | undefined
  address_line1?: string | undefined
  address_line2?: string | undefined
  city?: string | undefined
  region?: string | undefined
  postal_code?: string | undefined
  country?: string | undefined
}

/** A company an admin can attach to a user (see /admin/organizations). */
export interface Organization {
  id: string
  name: string
}

export interface OrganizationList {
  organizations: Organization[]
}

/**
 * Fallback groups used only until `fetchGroups` resolves (or if it fails) —
 * the baseline Cognito groups Terraform provisions (modules/cloud/aws/auth).
 * The live list comes from `GET /api/v1/admin/groups` so a deployment that
 * customizes its taxonomy needs no UI edit (issue #148).
 */
export const ASSIGNABLE_GROUPS = ['admin', 'editor', 'viewer'] as const

export interface GroupList {
  groups: string[]
}

type Client = ReturnType<typeof createApiClient>

/** List the Cognito groups a user can be assigned to on this deployment. */
export function fetchGroups(client: Pick<Client, 'get'>): Promise<GroupList> {
  return client.get<GroupList>('/api/v1/admin/groups')
}

const BASE = '/api/v1/admin/users'

export function fetchUsers(client: Pick<Client, 'get'>): Promise<AdminUserList> {
  return client.get<AdminUserList>(BASE)
}

export function createUser(
  client: Pick<Client, 'post'>,
  body: CreateUserRequest,
): Promise<AdminUser> {
  return client.post<AdminUser>(BASE, body)
}

export function assignGroup(
  client: Pick<Client, 'post'>,
  username: string,
  group: string,
): Promise<AdminUser> {
  return client.post<AdminUser>(`${BASE}/${encodeURIComponent(username)}/groups`, { group })
}

export function removeGroup(
  client: Pick<Client, 'delete'>,
  username: string,
  group: string,
): Promise<AdminUser> {
  return client.delete<AdminUser>(
    `${BASE}/${encodeURIComponent(username)}/groups/${encodeURIComponent(group)}`,
  )
}

export function suspendUser(client: Pick<Client, 'post'>, username: string): Promise<AdminUser> {
  return client.post<AdminUser>(`${BASE}/${encodeURIComponent(username)}/suspend`, {})
}

export function reactivateUser(client: Pick<Client, 'post'>, username: string): Promise<AdminUser> {
  return client.post<AdminUser>(`${BASE}/${encodeURIComponent(username)}/reactivate`, {})
}

export async function deleteUser(client: Pick<Client, 'delete'>, username: string): Promise<void> {
  await client.delete(`${BASE}/${encodeURIComponent(username)}`)
}

export function updateUser(
  client: Pick<Client, 'patch'>,
  username: string,
  body: AdminUserUpdateRequest,
): Promise<AdminUser> {
  return client.patch<AdminUser>(`${BASE}/${encodeURIComponent(username)}`, body)
}

/**
 * Force the user onto Cognito's own Forgot Password flow (#633). This does
 * NOT itself email anything — see CognitoAdmin.reset_password's docstring —
 * so the caller should tell the admin the user must use "Forgot password"
 * next time they try to sign in, not that a new password was just emailed.
 */
export function resetPassword(client: Pick<Client, 'post'>, username: string): Promise<AdminUser> {
  return client.post<AdminUser>(`${BASE}/${encodeURIComponent(username)}/reset-password`, {})
}

const ORGANIZATIONS_BASE = '/api/v1/admin/organizations'

/** List organizations for the "Company" picker. */
export function fetchOrganizations(client: Pick<Client, 'get'>): Promise<OrganizationList> {
  return client.get<OrganizationList>(ORGANIZATIONS_BASE)
}

/** Add a new organization (e.g. from the "Company" picker's "add new" option). */
export function createOrganization(
  client: Pick<Client, 'post'>,
  name: string,
): Promise<Organization> {
  return client.post<Organization>(ORGANIZATIONS_BASE, { name })
}
