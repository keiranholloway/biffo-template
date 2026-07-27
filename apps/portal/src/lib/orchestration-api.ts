import type { createApiClient } from './api-client'
import type { PromptPart } from './prompt-parts'

/**
 * A value in `action_config`. Scalar fields store a string; a `multiselect`
 * (the tool picker) stores a string list; a `parts: true` prompt field
 * (`instructions`/`goals`, ADR-0015) stores an ordered list of parts. Core
 * accepts a plain string there too (one inline part) — that arrives typed as a
 * string, the pre-library shape.
 */
export type ActionConfigValue =
  string | string[] | PromptPart[] | DeliveryConfigValue | WriteBackConfigValue

/**
 * The agent action's optional deliver-on-completion sub-config (ADR-0020, #527).
 * `type` names a destination action (`email`/`slack`/`google_chat`/`whatsapp`)
 * and `config` is that destination's own config, keyed by its `config_fields`.
 * Absent from `action_config` ⇒ no delivery (unchanged behaviour). It nests the
 * same value type recursively — a destination's config is itself action config.
 */
export interface DeliveryConfigValue {
  type: string
  config: Record<string, ActionConfigValue>
}

/**
 * An optional delay before a workflow definition's action fires (docs/
 * implementation/0002-scheduled-workflow-actions) — e.g. a follow-up email 2
 * weeks after onboarding. `type` is a discriminator left for a future
 * "relative to a payload timestamp field" variant; only `fixed_delay` exists
 * today. Absent from a definition ⇒ fires immediately (unchanged behaviour).
 */
export interface ScheduleConfig {
  type: 'fixed_delay'
  delay_seconds: number
}

/**
 * An optional hierarchy scope on a workflow definition (docs/implementation/
 * 0003-hierarchy-scoped-workflows) — e.g. "this rule applies to Brand X and
 * everything beneath it," not just an exact trigger match. `level` is one of
 * the catalog's `scope_levels` (empty when the instance has registered no
 * hierarchy resolver at all — see `WorkflowCatalog`). Absent from a
 * definition ⇒ unscoped/tenant-wide, unchanged behaviour.
 */
export interface WorkflowScope {
  level: string
  id: string
}

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
  /**
   * Optional all-of exact-match predicate over the event payload: every entry
   * must equal the event's value for the workflow to run. Null/empty matches
   * every event — that's how a coarse trigger like `leads.updated` becomes a
   * precise one ("...and only when status is won").
   */
  trigger_filter: Record<string, string> | null
  /**
   * Whose authority this workflow's actions run under (ADR-0027 §2). Stamped
   * from the authenticated caller on every save and every enable — so it names
   * whoever last vouched for the rule as it stands, not merely who created it.
   * Read-only: it is never accepted from a request body.
   */
  run_as_user_id?: string | null
  run_as_kind?: string
  action_type: string
  /**
   * Per-field action config. Values are strings for scalar fields; a
   * `multiselect` field (e.g. the agent action's tool picker) stores a list; a
   * `parts: true` prompt field stores an ordered-parts list (ADR-0015).
   */
  action_config: Record<string, ActionConfigValue>
  enabled: boolean
  schedule_config: ScheduleConfig | null
  scope: WorkflowScope | null
}

/** The create/update body — the Core API validates action_config per action_type. */
export interface WorkflowInput {
  name: string
  trigger_source: string
  trigger_detail_type: string
  trigger_filter: Record<string, string> | null
  action_type: string
  action_config: Record<string, ActionConfigValue>
  enabled: boolean
  schedule_config: ScheduleConfig | null
  scope: WorkflowScope | null
}

/**
 * One field of a trigger's event payload, described so the "Only when…"
 * condition editor can offer real field names (and enumerable values) instead
 * of un-guessable free text (#505). Advisory only — Core never rejects a
 * `trigger_filter` on a field not listed here.
 */
export interface CatalogTriggerField {
  name: string
  label: string
  /** Coarse UI hint. `enum` drives a value dropdown from `values`. */
  type: 'string' | 'number' | 'boolean' | 'enum'
  /** Selectable values for an enumerable field; empty means free-text value. */
  values: string[]
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
  /**
   * The trigger's payload fields, for the condition editor's dropdowns (#505).
   * Optional so the portal still renders against a Core API predating it; a
   * missing or empty list means "no known fields" → free-text conditions.
   */
  fields?: CatalogTriggerField[]
}

export interface CatalogActionField {
  name: string
  label: string
  /**
   * `select` picks one value; `multiselect` renders a set of checkboxes and
   * stores a list of the chosen values into action_config. Anything unknown is
   * rendered as a plain text input.
   */
  type:
    | 'email'
    | 'text'
    | 'textarea'
    | 'url'
    | 'tel'
    | 'number'
    | 'select'
    | 'multiselect'
    // The agent action's optional deliver-on-completion sub-config (ADR-0020,
    // #527). Rendered by the builder's Delivery section, never as a plain input.
    | 'delivery'
    // The agent action's optional record-the-result sub-config (ADR-0027).
    // Rendered by the builder's "Record the result" section against the
    // catalog's `writeback_targets`, never as a plain input.
    | 'writeback'
    // A fan-in agent's structured result contract (#729) — the inline JSON tool
    // schema it must call to answer. Structured, so never a plain input: a
    // string typed into a text box is not a tool schema. It has no dedicated
    // control yet, so the builder round-trips the stored value untouched.
    | 'output_tools'
  required: boolean
  /**
   * `true` marks the value a credential (#432): a Slack/Google Chat webhook URL.
   * Reads redact it to a sentinel and writes echoing the sentinel keep the stored
   * value — the builder round-trips the sentinel and never has to see the secret.
   */
  secret?: boolean
  /**
   * `true` marks the one field carrying the human message (email → `body`, the
   * webhook channels → `message`). In a *delivery* it becomes optional and
   * defaults to the `{output}` placeholder server-side (ADR-0020).
   */
  output_body?: boolean
  /**
   * On a `select`, marks its `options` a suggestion list rather than an
   * allowlist — any value is accepted (the agent action's `model` uses this).
   */
  open?: boolean
  /**
   * `true` on a prompt field composed from ordered parts (ADR-0015 §2) —
   * `instructions`/`goals` on the agent action. The builder renders these with
   * the ordered-parts editor instead of a plain textarea. Core accepts either a
   * plain string (one inline part) or a parts list here.
   */
  parts?: boolean
  /**
   * `true` on a recipient/target field (email/WhatsApp `to`) that accepts a
   * `{field}` template filled from the trigger's payload at dispatch time —
   * e.g. `{email}` to notify whoever triggered the run — in addition to a
   * literal value. Drives the builder's "insert field" picker.
   */
  payload_template?: boolean
  /** Value assumed when the field is absent from action_config. */
  default?: string
  /**
   * Choices for a `select` or `multiselect` field. `description` (used by the
   * tool picker) is shown as per-option help text.
   */
  options?: { value: string; label: string; description?: string }[]
  /** The field only applies while this sibling's effective value matches. */
  visible_when?: { field: string; equals: string }
}

/**
 * A tool the agent runtime registered (ADR-0014 §7), surfaced on the agent
 * action so the builder can offer a picker whose options come from the runtime's
 * own manifest — never a hardcoded list. This is discoverability, not the
 * security boundary: the runtime enforces the declared-tools allowlist at
 * run-start regardless of what the builder shows.
 */
export interface AvailableTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface CatalogAction {
  type: string
  label: string
  config_fields: CatalogActionField[]
  /**
   * Present on the agent action only: the tools the runtime declared. The
   * builder turns these into a `tools` multiselect. Absent/empty on every other
   * action, and on an instance whose runtime registered no tools.
   */
  available_tools?: AvailableTool[]
}

/**
 * One column an agent may be asked to fill on a write-back target (ADR-0027).
 *
 * `overwrite` is the one worth surfacing to an author: `if_empty` fills a gap
 * and never replaces what a person typed, `append` adds beneath it, `always`
 * replaces. It is the target's decision, not the workflow's — shown, not editable.
 */
export interface WriteBackTargetColumn {
  name: string
  label: string
  type: string
  required: boolean
  values: string[]
  overwrite: 'if_empty' | 'append' | 'always'
}

/**
 * A table this caller may have an agent write to (ADR-0027 §3).
 *
 * The list is filtered by Core to what *this user* can write, so an empty array
 * means "you cannot write anywhere", not "this deployment has no targets". The
 * columns are the ceiling: a workflow can narrow them, never widen.
 *
 * `scope_levels` non-empty means the workflow must be scoped to one of those
 * levels — the target derives a column (e.g. a lead's brand) from it, and Core
 * refuses to save an unscoped definition. `row_selector` names the trigger
 * payload field that identifies the row an `update` amends; it comes from the
 * event, never from the agent.
 */
export interface WriteBackTarget {
  table: string
  label: string
  operations: string[]
  scope_levels: string[]
  row_selector: string | null
  columns: WriteBackTargetColumn[]
}

/**
 * The `writeback` field's value: which table, which operation, and what fills
 * each chosen column. A source is a literal or a `{output.<field>}` reference to
 * the agent's submitted record.
 */
export interface WriteBackConfigValue {
  table: string
  operation: string
  columns: Record<string, string>
}

/** What the builder offers — drives the trigger/action dropdowns and config fields. */
export interface WorkflowCatalog {
  triggers: CatalogTrigger[]
  actions: CatalogAction[]
  /**
   * The active hierarchy scope resolver's declared levels, broad-to-narrow
   * (docs/implementation/0003-hierarchy-scoped-workflows) — feeds the Scope
   * picker's level dropdown. Empty when the instance has registered no
   * resolver at all, in which case the Scope section is not offered.
   */
  scope_levels: string[]
  /**
   * The write-back targets **this caller** may write to (ADR-0027). Filtered by
   * Core per user, so the picker can never offer a table the author could not
   * save against. Empty for an instance that registers none — the builder then
   * omits the section entirely.
   */
  writeback_targets?: WriteBackTarget[]
}

/**
 * One recorded action outcome for a run. The Core API deliberately omits the
 * action's `request` — it echoes the action config, which can carry a
 * credential — so the outcome is all the history view gets.
 */
export interface ActionLogEntry {
  id: string
  created_at: string | null
  run_id: string
  action_type: string
  status: string
  response: Record<string, unknown> | null
  error: string | null
}

/** One execution of a workflow for one event. `definition_name` is null when
 * the workflow has since been deleted — the run outlives the rule. */
export interface WorkflowRun {
  id: string
  tenant_id: string
  created_at: string | null
  updated_at: string | null
  definition_id: string
  definition_name: string | null
  status: string
  trigger_event: Record<string, unknown>
  logs: ActionLogEntry[]
  /** Set only for a run whose definition carries a schedule — the UTC instant
   * its EventBridge Scheduler one-time schedule will fire (or fired). */
  scheduled_for: string | null
}

type Client = ReturnType<typeof createApiClient>

const BASE = '/api/v1/orchestration/workflows'
const RUNS_BASE = '/api/v1/orchestration/runs'

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

/** Most-recent-first run history: what fired, when, and how it turned out. */
export function fetchRuns(client: Pick<Client, 'get'>, limit = 25): Promise<WorkflowRun[]> {
  return client.get<WorkflowRun[]>(`${RUNS_BASE}?limit=${String(limit)}`)
}
