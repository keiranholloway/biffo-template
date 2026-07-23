import type { createApiClient } from './api-client'

/**
 * The prompt-authoring assistant chat turn (ADR-0016). Buffered — not streaming.
 * Mirrors the Core request body of `POST /api/v1/admin/agent-chat`: a `message`
 * (1..16000 chars, validated server-side) and an optional `thread_id`. Omit
 * `thread_id` to start a new conversation; echo back the one the first response
 * returned on every subsequent turn to continue it.
 */
export interface AgentChatRequest {
  message: string
  thread_id?: string
}

/**
 * A completed assistant turn. `thread_id` identifies the conversation to
 * continue; `reply` is the assistant's prose. `model`/token counts/`cost_usd`
 * are present when the runtime reported them and are display-only.
 */
export interface AgentChatResponse {
  thread_id: string
  run_id: string
  reply: string
  model?: string
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
}

type Client = ReturnType<typeof createApiClient>

const BASE = '/api/v1/admin/agent-chat'

/**
 * Run one buffered chat turn. Resolves with the assistant reply and the
 * `thread_id` to thread onto the next turn. Rejects with an `ApiError` carrying
 * the HTTP status — the drawer distinguishes 502 (transient runtime failure, let
 * the user retry) from 503 (assistant not configured on this deployment).
 */
export function sendAgentChat(
  client: Pick<Client, 'post'>,
  body: AgentChatRequest,
): Promise<AgentChatResponse> {
  return client.post<AgentChatResponse>(BASE, body)
}
