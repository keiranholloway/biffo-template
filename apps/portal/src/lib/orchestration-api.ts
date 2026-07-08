import type { createApiClient } from './api-client'

/**
 * An orchestration workflow definition as surfaced by the Core API
 * (`/api/v1/orchestration/workflows`): a trigger (event) mapped to an action.
 * The engine reads the enabled ones matching each incoming event.
 */
export interface WorkflowDefinition {
  id: string
  tenant_id: string
  created_at: string | null
  updated_at: string | null
  name: string
  trigger_source: string
  trigger_detail_type: string
  action_type: string
  action_config: Record<string, string>
  enabled: boolean
}

/** The create/update body — the Core API validates action_config per action_type. */
export interface WorkflowInput {
  name: string
  trigger_source: string
  trigger_detail_type: string
  action_type: string
  action_config: Record<string, string>
  enabled: boolean
}

export interface CatalogTrigger {
  source: string
  detail_type: string
  label: string
  description: string
}

export interface CatalogActionField {
  name: string
  label: string
  type: 'email' | 'text' | 'textarea' | 'url' | 'tel'
  required: boolean
}

export interface CatalogAction {
  type: string
  label: string
  config_fields: CatalogActionField[]
}

/** What the builder offers — drives the trigger/action dropdowns and config fields. */
export interface WorkflowCatalog {
  triggers: CatalogTrigger[]
  actions: CatalogAction[]
}

type Client = ReturnType<typeof createApiClient>

const BASE = '/api/v1/orchestration/workflows'

export function fetchWorkflows(client: Pick<Client, 'get'>): Promise<WorkflowDefinition[]> {
  return client.get<WorkflowDefinition[]>(BASE)
}

export function fetchCatalog(client: Pick<Client, 'get'>): Promise<WorkflowCatalog> {
  return client.get<WorkflowCatalog>(`${BASE}/catalog`)
}

export function createWorkflow(
  client: Pick<Client, 'post'>,
  body: WorkflowInput,
): Promise<WorkflowDefinition> {
  return client.post<WorkflowDefinition>(BASE, body)
}

export function updateWorkflow(
  client: Pick<Client, 'put'>,
  id: string,
  body: WorkflowInput,
): Promise<WorkflowDefinition> {
  return client.put<WorkflowDefinition>(`${BASE}/${encodeURIComponent(id)}`, body)
}

export function setWorkflowEnabled(
  client: Pick<Client, 'post'>,
  id: string,
  enabled: boolean,
): Promise<WorkflowDefinition> {
  return client.post<WorkflowDefinition>(`${BASE}/${encodeURIComponent(id)}/enabled`, { enabled })
}

export async function deleteWorkflow(client: Pick<Client, 'delete'>, id: string): Promise<void> {
  await client.delete(`${BASE}/${encodeURIComponent(id)}`)
}
