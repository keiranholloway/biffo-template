'use client'

import { useMemo, useRef, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { ApiError, createApiClient } from '@/lib/api-client'
import { sendAgentChat, type AgentChatResponse } from '@/lib/agent-chat-api'

/**
 * What the author is drafting when they open the assistant. Drives the drawer's
 * one-line header and the short context line seeded onto the first turn. This is
 * display/seed metadata only — it never changes the Core request/response
 * contract (the seed rides inside the existing `message` field, §ADR-0016).
 */
export interface AssistantContext {
  kind: 'agent-instructions' | 'agent-goals' | 'component-body'
  agentName?: string | undefined
  model?: string | undefined
  componentName?: string | undefined
}

interface AssistantDrawerProps {
  open: boolean
  onClose: () => void
  /** Called with the chosen assistant reply when the author clicks "Use this
   *  draft". The drawer closes immediately after. */
  onAccept: (text: string) => void
  context: AssistantContext
}

/** Pull the FastAPI `{detail}` out of an error body when there is one, else fall
 *  back to the raw text — Core returns `{"detail": "…"}` for 502/503. */
function detailOf(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const parsed = JSON.parse(err.message) as { detail?: unknown }
      if (typeof parsed.detail === 'string' && parsed.detail !== '') return parsed.detail
    } catch {
      // Body was not JSON — use it as-is.
    }
    return err.message === '' ? `Request failed (${String(err.status)})` : err.message
  }
  return err instanceof Error ? err.message : 'Unknown error'
}

/** One turn in the running transcript. `meta` is display-only, present on
 *  assistant turns when the runtime reported it. */
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  meta?: { model?: string | undefined; cost_usd?: number | undefined }
}

/** Human phrase for what's being drafted — used in the header and the seed line
 *  so both read naturally. */
function contextLabel(ctx: AssistantContext): string {
  switch (ctx.kind) {
    case 'agent-instructions':
      return ctx.agentName != null && ctx.agentName !== ''
        ? `instructions for agent “${ctx.agentName}”`
        : 'agent instructions'
    case 'agent-goals':
      return ctx.agentName != null && ctx.agentName !== ''
        ? `goals for agent “${ctx.agentName}”`
        : 'agent goals'
    case 'component-body':
      return ctx.componentName != null && ctx.componentName !== ''
        ? `the body of prompt component “${ctx.componentName}”`
        : 'a prompt component body'
  }
}

/**
 * The short, clearly-labelled context line prepended to the FIRST user turn
 * only. It seeds the assistant with what the author is drafting. It rides inside
 * the untrusted-user `message` channel — deliberately NOT a new field or
 * endpoint — so the Core request/response contract is unchanged.
 */
function seedLine(ctx: AssistantContext): string {
  const modelNote =
    (ctx.kind === 'agent-instructions' || ctx.kind === 'agent-goals') &&
    ctx.model != null &&
    ctx.model !== ''
      ? ` (model: ${ctx.model})`
      : ''
  return `[Context — I'm drafting ${contextLabel(ctx)}${modelNote}. Please help me write it; my request follows.]`
}

/**
 * Right-side slide-in drawer that runs the prompt-authoring assistant in place,
 * beside the field being authored (ADR-0016). Buffered chat against
 * `POST /api/v1/admin/agent-chat` via {@link sendAgentChat}; threads `thread_id`
 * across turns. The manual editor stays the frictionless default — this is the
 * optional "✨ Draft with AI" path.
 *
 * The drawer is unmounted while closed (the parent renders it only when open),
 * so each drafting session starts fresh and the first turn re-seeds the context.
 */
export function AssistantDrawer({ open, onClose, onAccept, context }: AssistantDrawerProps) {
  const { getIdToken } = useAuth()
  const client = useMemo(() => createApiClient(getIdToken), [getIdToken])

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 503: the assistant is not wired up on this deployment. Once seen, the input
  // is disabled — retrying cannot succeed until the deployment is configured.
  const [notConfigured, setNotConfigured] = useState<string | null>(null)

  const inputRef = useRef<HTMLTextAreaElement>(null)

  const canSend = !busy && notConfigured == null && input.trim() !== ''

  async function send() {
    const message = input.trim()
    if (message === '' || busy || notConfigured != null) return

    // Seed the context onto the first turn only; the transcript still shows the
    // author's raw text. Subsequent turns are the user's text verbatim.
    const isFirstTurn = messages.length === 0
    const outbound = isFirstTurn ? `${seedLine(context)}\n\n${message}` : message

    setMessages((m) => [...m, { role: 'user', content: message }])
    setInput('')
    setError(null)
    setBusy(true)
    try {
      const res: AgentChatResponse = await sendAgentChat(client, {
        message: outbound,
        ...(threadId != null ? { thread_id: threadId } : {}),
      })
      setThreadId(res.thread_id)
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: res.reply,
          meta: { model: res.model, cost_usd: res.cost_usd },
        },
      ])
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 503) {
        // 503 → show the server detail ONCE, disable the input. (Historically the
        // standalone page printed a hardcoded sentence AND the identical detail,
        // doubling it — ADR-0016 rework fixes that here.)
        setNotConfigured(detailOf(err))
      } else {
        // 502 and anything else: transient. Keep the input enabled so the
        // author can retry; the user turn stays in the transcript.
        setError(detailOf(err))
      }
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40" aria-hidden={false}>
      {/* Light backdrop: dims but does not hide the form behind it, and closes
          the drawer on click. */}
      <button
        type="button"
        aria-label="Close assistant"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/20"
      />
      <aside
        role="dialog"
        aria-label="Draft with AI"
        className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l bg-white shadow-xl"
      >
        <header className="flex items-start justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Draft with AI</h2>
            <p className="mt-0.5 text-xs text-gray-500">Drafting {contextLabel(context)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            Close
          </button>
        </header>

        {notConfigured != null && (
          <div
            className="mx-4 mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800"
            role="alert"
          >
            {notConfigured}
          </div>
        )}

        {error != null && (
          <div
            className="mx-4 mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700"
            role="alert"
          >
            {error}
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-label="Conversation">
          {messages.length === 0 && notConfigured == null && (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center">
              <p className="text-sm font-medium text-gray-600">No messages yet</p>
              <p className="mt-1 text-xs text-gray-400">
                Describe what you want and the assistant drafts it. Use a reply with “Use this
                draft”.
              </p>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div
                key={i}
                data-testid="message-user"
                className="ml-auto max-w-[90%] rounded-lg border-l-4 border-l-indigo-400 bg-indigo-50/50 p-3"
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  You
                </p>
                <pre className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-800">
                  {m.content}
                </pre>
              </div>
            ) : (
              <div
                key={i}
                data-testid="message-assistant"
                className="mr-auto max-w-[90%] rounded-lg border-l-4 border-l-emerald-400 bg-emerald-50/40 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                    Assistant
                  </span>
                  {m.meta?.model != null && m.meta.model !== '' && (
                    <span className="text-[11px] text-gray-400">{m.meta.model}</span>
                  )}
                  {m.meta?.cost_usd != null && (
                    <span className="text-[11px] text-gray-400">${m.meta.cost_usd.toFixed(4)}</span>
                  )}
                </div>
                <pre className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-800">
                  {m.content}
                </pre>
                <div className="mt-2 border-t border-emerald-100 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      onAccept(m.content)
                      onClose()
                    }}
                    className="rounded border px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                  >
                    Use this draft
                  </button>
                </div>
              </div>
            ),
          )}
          {busy && (
            <div
              className="mr-auto flex max-w-[90%] items-center gap-2 rounded-lg border-l-4 border-l-emerald-400 bg-emerald-50/40 p-3"
              aria-label="Assistant is thinking"
            >
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-emerald-600" />
              <span className="text-sm text-gray-500">Thinking…</span>
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
          className="border-t px-4 py-3"
        >
          <textarea
            ref={inputRef}
            aria-label="Message"
            value={input}
            disabled={notConfigured != null}
            onChange={(e) => {
              setInput(e.target.value)
            }}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            rows={3}
            placeholder="Draft instructions for an agent that triages inbound leads…"
            className="w-full rounded border px-3 py-2 text-sm disabled:bg-gray-100"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-gray-400">
              Enter to send · Shift+Enter for a new line
            </span>
            <button
              type="submit"
              disabled={!canSend}
              className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </aside>
    </div>
  )
}
