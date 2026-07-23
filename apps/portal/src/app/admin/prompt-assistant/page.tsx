'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useRef, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { ApiError, createApiClient } from '@/lib/api-client'
import { sendAgentChat, type AgentChatResponse } from '@/lib/agent-chat-api'
import { HANDOFF_ROUTE, stashHandoff, type HandoffTarget } from '@/lib/prompt-handoff'

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

/** Where an assistant reply can be handed off to, and its human label. */
const HANDOFF_ACTIONS: { target: HandoffTarget; label: string }[] = [
  { target: 'prompt-component-body', label: 'Send to prompt component' },
  { target: 'agent-instructions', label: 'Send to agent instructions' },
  { target: 'agent-goals', label: 'Send to agent goals' },
]

function UseThis({ text }: { text: string }) {
  const router = useRouter()
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-emerald-100 pt-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        Use this
      </span>
      {HANDOFF_ACTIONS.map(({ target, label }) => (
        <button
          key={target}
          type="button"
          onClick={() => {
            stashHandoff({ target, text })
            router.push(HANDOFF_ROUTE[target])
          }}
          className="rounded border px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export default function PromptAssistantPage() {
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

    setMessages((m) => [...m, { role: 'user', content: message }])
    setInput('')
    setError(null)
    setBusy(true)
    try {
      const res: AgentChatResponse = await sendAgentChat(client, {
        message,
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

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Prompt assistant</h1>
      <p className="mt-1 text-sm text-gray-600">
        An authoring aid (ADR-0016). Describe what you want an agent to do and the assistant helps
        you write it — prompt-component bodies, agent instructions, and goals. Use the “Use this”
        control on any reply to send it straight into the prompt library or a workflow’s agent
        action.
      </p>

      {notConfigured != null && (
        <div className="mt-6 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          The prompt assistant is not configured on this deployment. {notConfigured}
        </div>
      )}

      {error != null && (
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      <div className="mt-6 space-y-3" aria-label="Conversation">
        {messages.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
            <p className="text-sm font-medium text-gray-600">No messages yet</p>
            <p className="mt-1 text-xs text-gray-400">
              Ask the assistant to draft a prompt component, instructions, or goals below.
            </p>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div
              key={i}
              data-testid="message-user"
              className="ml-auto max-w-[85%] rounded-lg border-l-4 border-l-indigo-400 bg-indigo-50/50 p-3"
            >
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">You</p>
              <pre className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-800">
                {m.content}
              </pre>
            </div>
          ) : (
            <div
              key={i}
              data-testid="message-assistant"
              className="mr-auto max-w-[85%] rounded-lg border-l-4 border-l-emerald-400 bg-emerald-50/40 p-3"
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
              <UseThis text={m.content} />
            </div>
          ),
        )}
        {busy && (
          <div
            className="mr-auto flex max-w-[85%] items-center gap-2 rounded-lg border-l-4 border-l-emerald-400 bg-emerald-50/40 p-3"
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
        className="mt-4"
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
          <span className="text-xs text-gray-400">Enter to send · Shift+Enter for a new line</span>
          <button
            type="submit"
            disabled={!canSend}
            className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  )
}
