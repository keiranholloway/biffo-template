import type { createApiClient } from './api-client'

/**
 * One message in a run's transcript, in the OpenAI/OpenRouter chat shape the
 * runtime persists verbatim (services/_plugins/agent-runtime/messages.py). The
 * `content` of a `user` context message or a `tool` result is fenced with the
 * `<untrusted-context>` / `<untrusted-tool-result tool="…">` markers — that
 * fencing is literal text in the stored content, and rendering it as
 * data-not-instructions is the whole point of the inspector.
 */
export interface AgentRunMessage {
  role: string
  content?: string | null
  /** Present on an assistant turn that called tools; replayed verbatim. */
  tool_calls?: unknown[]
  /** Present on a `tool` result: the call it answers, and the tool's name. */
  tool_call_id?: string
  name?: string
  [key: string]: unknown
}

/**
 * A run as the admin list view shows it — enough to scan and triage, none of
 * the heavy content. Mirrors `AgentRunSummary` in
 * services/api/src/api/schemas/agent_run.py. `model` is lifted out of the
 * definition snapshot (the one snapshot field worth a column, it drives cost)
 * and is null when the snapshot recorded none.
 */
export interface AgentRunSummary {
  id: string
  tenant_id: string
  created_at: string | null
  updated_at: string | null
  agent_name: string
  status: string
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  started_at: string | null
  completed_at: string | null
}

/**
 * A full run record — the detail view. Mirrors `AgentRunResponse`. The
 * `definition_snapshot` is the resolved definition the run executed
 * (instructions, model, tools, read scope, limits), captured verbatim so the
 * run stays explainable after its definition is edited in place (ADR-0014 §10).
 */
export interface AgentRunResponse {
  id: string
  tenant_id: string
  created_at: string | null
  updated_at: string | null
  workflow_run_id: string | null
  dry_run: boolean
  idempotency_key: string | null
  agent_name: string
  status: string
  run_as_kind: string
  run_as_user_id: string | null
  thread_id: string | null
  causation_id: string | null
  depth: number
  definition_snapshot: Record<string, unknown>
  input_payload: Record<string, unknown>
  messages: AgentRunMessage[]
  result: Record<string, unknown> | null
  error: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  started_at: string | null
  completed_at: string | null
  prompt_version_id: string | null
  prompt_version: number | null
}

/** Server-side filters the list endpoint accepts. */
export interface AgentRunFilters {
  agent_name?: string | undefined
  status?: string | undefined
  limit?: number | undefined
  offset?: number | undefined
}

type Client = ReturnType<typeof createApiClient>

const BASE = '/api/v1/admin/agent-runs'

/** Newest-first, paginated list of this tenant's agent runs. */
export function fetchAgentRuns(
  client: Pick<Client, 'get'>,
  filters: AgentRunFilters = {},
): Promise<AgentRunSummary[]> {
  const params = new URLSearchParams()
  if (filters.agent_name != null && filters.agent_name !== '') {
    params.set('agent_name', filters.agent_name)
  }
  if (filters.status != null && filters.status !== '') {
    params.set('status', filters.status)
  }
  if (filters.limit != null) params.set('limit', String(filters.limit))
  if (filters.offset != null) params.set('offset', String(filters.offset))
  const query = params.toString()
  return client.get<AgentRunSummary[]>(query === '' ? BASE : `${BASE}?${query}`)
}

/** One run in full — transcript, result, definition snapshot, payload, cost. */
export function fetchAgentRun(
  client: Pick<Client, 'get'>,
  runId: string,
): Promise<AgentRunResponse> {
  return client.get<AgentRunResponse>(`${BASE}/${encodeURIComponent(runId)}`)
}

/**
 * Per-model cost aggregation. Mirrors `AgentRunCostAggregate` in
 * services/api/src/api/schemas/agent_run.py. `model` is null for runs whose
 * snapshot recorded none; render that row as explicit "unknown model" text, not
 * an empty cell. `unpriced_runs` counts runs with cost_usd == null (billing
 * failed, or provider did not report); they are excluded from total_cost_usd.
 * A total with unpriced_runs > 0 is a floor, not a fact — render the count
 * next to the total; do not hide it.
 */
export interface AgentRunCostAggregate {
  model: string | null
  runs: number
  total_cost_usd: number
  total_input_tokens: number
  total_output_tokens: number
  unpriced_runs: number
}

/** Filter options for cost aggregation. */
export interface AgentRunCostFilters {
  agent_name?: string | undefined
  since?: string | undefined
  until?: string | undefined
}

/** Per-model cost aggregates, newest-first 30-day window by default. */
export function fetchAgentRunCosts(
  client: Pick<Client, 'get'>,
  filters: AgentRunCostFilters = {},
): Promise<AgentRunCostAggregate[]> {
  const params = new URLSearchParams()
  if (filters.agent_name != null && filters.agent_name !== '') {
    params.set('agent_name', filters.agent_name)
  }
  if (filters.since != null && filters.since !== '') {
    params.set('since', filters.since)
  }
  if (filters.until != null && filters.until !== '') {
    params.set('until', filters.until)
  }
  const query = params.toString()
  return client.get<AgentRunCostAggregate[]>(`${BASE}/costs${query === '' ? '' : `?${query}`}`)
}
