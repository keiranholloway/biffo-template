import type { createApiClient } from './api-client'

/**
 * A declared variable slot on a prompt component (ADR-0015 §1). `name` is a
 * placeholder-safe identifier — what appears inside `{{ }}` in the body. A
 * component with zero variables is the "house style" case; variables make it a
 * parameterised-family template. `description`/`default` are optional and are
 * omitted (not sent as empty strings) by the authoring UI.
 */
export interface PromptVariable {
  name: string
  description?: string
  required: boolean
  default?: string
}

/**
 * A prompt-library component as returned by the Core admin API
 * (`GET /api/v1/admin/prompt-components`). Mirrors `PromptComponentResponse`:
 * `BiffoBaseSchema` fields plus name/description/body/variables. Referenced (not
 * copied) by workflow definitions and resolved Core-side at run-creation.
 */
export interface PromptComponent {
  id: string
  tenant_id: string
  created_at: string
  updated_at: string
  name: string
  description: string | null
  body: string
  variables: PromptVariable[]
}

/**
 * The create/update body — mirrors `PromptComponentBody`. The Core API is the
 * authority: it enforces per-tenant name uniqueness (409) and the variable shape
 * (422). This type is the shape the UI submits; correctness is validated server-
 * side.
 */
export interface PromptComponentInput {
  name: string
  description?: string | null
  body: string
  variables: PromptVariable[]
}

type Client = ReturnType<typeof createApiClient>

const BASE = '/api/v1/admin/prompt-components'

export function fetchPromptComponents(client: Pick<Client, 'get'>): Promise<PromptComponent[]> {
  return client.get<PromptComponent[]>(BASE)
}

export function fetchPromptComponent(
  client: Pick<Client, 'get'>,
  id: string,
): Promise<PromptComponent> {
  return client.get<PromptComponent>(`${BASE}/${encodeURIComponent(id)}`)
}

export function createPromptComponent(
  client: Pick<Client, 'post'>,
  body: PromptComponentInput,
): Promise<PromptComponent> {
  return client.post<PromptComponent>(BASE, body)
}

export function updatePromptComponent(
  client: Pick<Client, 'put'>,
  id: string,
  body: PromptComponentInput,
): Promise<PromptComponent> {
  return client.put<PromptComponent>(`${BASE}/${encodeURIComponent(id)}`, body)
}

export async function deletePromptComponent(
  client: Pick<Client, 'delete'>,
  id: string,
): Promise<void> {
  await client.delete(`${BASE}/${encodeURIComponent(id)}`)
}
