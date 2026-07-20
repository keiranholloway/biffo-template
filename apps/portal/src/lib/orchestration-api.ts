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
  /**
   * Where the catalog learned about this trigger: `declared` from the Core
   * event registry, `observed` from having actually seen it on the event bus.
   * Optional so this portal still renders against a Core API predating the
   * field; treat a missing value as `declared` (see `originOf`).
   */
  origin?: 'declared' | 'observed'
}

export interface CatalogActionField {
  name: string
  label: string
  type: 'email' | 'text' | 'textarea' | 'url' | 'tel' | 'select'
  required: boolean
  /** Value assumed when the field is absent from action_config. */
  default?: string
  /** Choices for a `select` field. */
  options?: { value: string; label: string }[]
  /** The field only applies while this sibling's effective value matches. */
  visible_when?: { field: string; equals: string }
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
