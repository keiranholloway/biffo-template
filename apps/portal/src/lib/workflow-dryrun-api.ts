import type { createApiClient } from './api-client'
import type { WriteBackConfigValue } from './orchestration-api'
import type { PromptPart } from './prompt-parts'

/**
 * The workflow "Test workflow" dry-run (issue #527, Phase 2; async since #726).
 * Mirrors Core's `POST /api/v1/admin/orchestration/test`: given a **draft**
 * agent-action config and a **sample event**, Core queues a real agent run
 * marked as a dry run and answers **202 with its id**. The caller polls
 * `GET /api/v1/admin/agent-runs/{run_id}` (`fetchAgentRun` in `agent-runs-api`)
 * for the outcome.
 *
 * It is deliberately draft-first: an inline config is accepted so a workflow can
 * be tested *before* it is saved or enabled.
 *
 * **Why it does not return the output.** A preview is a preview of a real agent,
 * and a real agent can run for minutes — a research agent routinely does. Core
 * cannot hold an HTTP response open that long: every API Gateway integration here
 * is capped at 29s and, on an HTTP API, 30s is a hard AWS ceiling rather than a
 * raisable quota. So the result arrives on the run row, not in this response.
 *
 * **No side effect still holds**, but it now means *nothing downstream reacts*
 * rather than *nothing is persisted*: Core withholds `agent.run.completed` for a
 * dry run, and that event is what fires write-backs and chained agents. A run row
 * and its transcript do persist — visible in Agent Runs, which is what you want
 * when testing an agent.
 *
 * `instructions`/`goals` accept EITHER a plain string (a single inline part — the
 * pre-library shape) OR an ordered list of prompt-library parts, exactly as a
 * saved agent action's `action_config` does (ADR-0015 §2).
 *
 * **Send the whole agent config, not the prompt half of it (#749).** This used
 * to carry four keys, so a write-back workflow was previewed with no write-back:
 * Core generates the terminal `submit_<table>_record` tool *from* `writeback`,
 * so omitting it left the model with no tool to call, answering in prose — the
 * one result shape a live write-back run treats as "no columns" and refuses to
 * write. The preview then reported success for the outcome that writes nothing.
 */
export interface WorkflowDryRunRequest {
  agent_name: string
  instructions: string | PromptPart[]
  goals?: string | PromptPart[] | null
  model?: string
  max_turns?: number
  /** The worker's declared tools (ADR-0014 §7). An agent previewed without its
   *  tools is a different agent from the one being enabled. */
  tools?: string[]
  /** The write-back sub-config (ADR-0027) — what makes Core attach the submit
   *  tool the model must call. Core answers 422 when no contract can be
   *  generated for it, because a live run would then write nothing. */
  writeback?: WriteBackConfigValue
  /** Whatever payload the builder wants to test against — fenced as untrusted
   *  data by the agent runtime, never interpreted here. Seeded from the
   *  trigger's declared fields (#505). */
  sample_event: Record<string, unknown>
  /** Advisory trigger context, carried for parity with the edited workflow. Core
   *  does not match or validate against it. */
  trigger?: { source: string; detail_type: string }
}

/**
 * The queued preview: an id to poll, and the run's own status vocabulary.
 *
 * `status` is `"pending"` here — queued, not started. It is named rather than
 * implied so a caller polls on the same words the run uses
 * (`pending`/`running`/`completed`/`failed`) instead of inventing a parallel set.
 */
export interface WorkflowDryRunAccepted {
  run_id: string
  status: string
}

type Client = ReturnType<typeof createApiClient>

const BASE = '/api/v1/admin/orchestration/test'

/**
 * Queue a no-side-effect preview run and resolve with the id to poll.
 *
 * Rejects with an `ApiError` carrying the HTTP status. Only **422** is meaningful
 * now (the draft's prompt parts do not resolve against this tenant's library).
 * The old 502 and 503 branches are gone with the synchronous invoke they
 * described: there is no in-request runtime call left to fail or to be
 * unconfigured. A runtime that is broken or absent now surfaces as a run that
 * fails, or one that never leaves `pending` — which is the poller's business,
 * not this call's.
 */
export function startWorkflowDryRun(
  client: Pick<Client, 'post'>,
  body: WorkflowDryRunRequest,
): Promise<WorkflowDryRunAccepted> {
  return client.post<WorkflowDryRunAccepted>(BASE, body)
}
