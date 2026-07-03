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
}

export interface AdminUserList {
  users: AdminUser[]
  next_token: string | null
}

export interface CreateUserRequest {
  email: string
  groups?: string[]
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
