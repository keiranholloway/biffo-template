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
 * The baseline groups a portal admin can assign, mirroring the Cognito groups
 * provisioned in Terraform (modules/cloud/aws/auth). Kept as a constant because
 * the Core API exposes no "list groups" endpoint; a deployment that customizes
 * its group taxonomy should update this list.
 */
export const ASSIGNABLE_GROUPS = ['admin', 'editor', 'viewer'] as const

type Client = ReturnType<typeof createApiClient>

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
