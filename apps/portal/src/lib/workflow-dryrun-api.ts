import type { createApiClient } from './api-client'
import type { PromptPart } from './prompt-parts'

/**
 * The workflow "Test workflow" dry-run (issue #527, Phase 2). Mirrors Core's
 * `POST /api/v1/admin/orchestration/test`: given a **draft** agent-action config
 * and a **sample event**, Core runs one agent turn and returns the produced
 * output for preview — with **no side effect** (nothing persisted, no event
 * emitted, no downstream action). It is deliberately draft-first: an inline
 * config is accepted so a workflow can be tested *before* it is saved or enabled.
 *
 * `instructions`/`goals` accept EITHER a plain string (a single inline part — the
 * pre-library shape) OR an ordered list of prompt-library parts, exactly as a
 * saved agent action's `action_config` does (ADR-0015 §2).
 */
export interface WorkflowDryRunRequest {
  agent_name: string
  instructions: string | PromptPart[]
  goals?: string | PromptPart[] | null
  model?: string
  max_turns?: number
  /** Whatever payload the builder wants to test against — fenced as untrusted
   *  data by Core, never interpreted here. Seeded from the trigger's declared
   *  fields (#505). */
  sample_event: Record<string, unknown>
  /** Advisory trigger context, carried for parity with the edited workflow. Core
   *  does not match or validate against it. */
  trigger?: { source: string; detail_type: string }
}

/** The runtime's output for one previewed turn. No ids — nothing was persisted.
 *  `model`/token counts/`cost_usd`/`finish_reason` are present when the runtime
 *  reported them and are display-only. */
export interface WorkflowDryRunResponse {
  output: string
  model?: string
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  finish_reason?: string
}

type Client = ReturnType<typeof createApiClient>

const BASE = '/api/v1/admin/orchestration/test'

/**
 * Run one no-side-effect agent turn against a sample event and resolve with the
 * produced output. Rejects with an `ApiError` carrying the HTTP status — the
 * Test & review panel distinguishes 503 (runtime not configured on this
 * deployment — testing unavailable), 502 (runtime turn failed — retryable) and
 * 422 (the draft's prompt parts do not resolve).
 */
export function runWorkflowDryRun(
  client: Pick<Client, 'post'>,
  body: WorkflowDryRunRequest,
): Promise<WorkflowDryRunResponse> {
  return client.post<WorkflowDryRunResponse>(BASE, body)
}
