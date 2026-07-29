'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { createApiClient } from '@/lib/api-client'
import { fetchAgentRun, type AgentRunMessage, type AgentRunResponse } from '@/lib/agent-runs-api'
import { formatCost, formatWhen } from '@/lib/agent-runs-format'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}

const statusClass: Record<string, string> = {
  completed: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-rose-100 text-rose-700',
  running: 'bg-sky-100 text-sky-700',
  pending: 'bg-gray-100 text-gray-600',
}

// One segment of a message's content: either trusted prose the model authored /
// was instructed with, or an untrusted block the runtime fenced as data.
interface ContentSegment {
  kind: 'trusted' | 'untrusted'
  /** For an untrusted block, the tool it came from (tool results only). */
  tool?: string | undefined
  text: string
}

// Matches the fence markers the runtime writes verbatim into stored content
// (services/_plugins/agent-runtime/messages.py). `<untrusted-context>` fences
// the triggering payload; `<untrusted-tool-result tool="…">` fences a tool
// result and names the tool. Everything between open/close is
// attacker-influenceable data, which is exactly what we must render as distinct
// from instructions.
const FENCE = /<untrusted-(context|tool-result)(?:\s+tool="([^"]*)")?>([\s\S]*?)<\/untrusted-\1>/g

/**
 * Split message content into trusted prose and untrusted fenced blocks so the
 * UI can show, at a glance, exactly what the model was told to treat as data.
 * Seeing what was fenced — not just the raw text — is the whole point of the
 * inspector.
 */
export function parseContent(content: string): ContentSegment[] {
  const segments: ContentSegment[] = []
  let lastIndex = 0
  for (const match of content.matchAll(FENCE)) {
    const start = match.index
    if (start > lastIndex) {
      const before = content.slice(lastIndex, start).trim()
      if (before !== '') segments.push({ kind: 'trusted', text: before })
    }
    segments.push({
      kind: 'untrusted',
      tool: match[2],
      text: (match[3] ?? '').trim(),
    })
    lastIndex = start + match[0].length
  }
  const rest = content.slice(lastIndex).trim()
  if (rest !== '') segments.push({ kind: 'trusted', text: rest })
  // No fence anywhere: the whole thing is trusted.
  if (segments.length === 0 && content.trim() !== '') {
    segments.push({ kind: 'trusted', text: content.trim() })
  }
  return segments
}

const roleLabel: Record<string, string> = {
  system: 'System',
  user: 'User (context)',
  assistant: 'Assistant',
  tool: 'Tool result',
}

const roleClass: Record<string, string> = {
  system: 'border-l-4 border-l-slate-400 bg-slate-50',
  user: 'border-l-4 border-l-indigo-400 bg-indigo-50/40',
  assistant: 'border-l-4 border-l-emerald-400 bg-emerald-50/40',
  tool: 'border-l-4 border-l-amber-400 bg-amber-50/40',
}

function UntrustedBlock({ tool, text }: { tool?: string | undefined; text: string }) {
  return (
    <div
      data-testid="untrusted-block"
      className="my-2 rounded border border-dashed border-amber-400 bg-amber-50 p-3"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
          Untrusted data — not instructions
        </span>
        {tool != null && tool !== '' && (
          <span className="text-[11px] text-amber-700">from tool: {tool}</span>
        )}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-amber-900">
        {text}
      </pre>
    </div>
  )
}

function MessageCard({ message, index }: { message: AgentRunMessage; index: number }) {
  const role = message.role
  const content = typeof message.content === 'string' ? message.content : ''
  const segments = parseContent(content)
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : null

  return (
    <div className={`rounded-lg p-3 ${roleClass[role] ?? 'border-l-4 border-l-gray-300 bg-white'}`}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-700">
          {roleLabel[role] ?? role}
        </span>
        {message.name != null && typeof message.name === 'string' && (
          <span className="text-[11px] text-gray-500">{message.name}</span>
        )}
        <span className="ml-auto text-[11px] text-gray-400">#{index + 1}</span>
      </div>
      {segments.map((seg, i) =>
        seg.kind === 'untrusted' ? (
          <UntrustedBlock key={i} tool={seg.tool} text={seg.text} />
        ) : (
          <pre
            key={i}
            className="overflow-x-auto whitespace-pre-wrap break-words text-sm text-gray-800"
          >
            {seg.text}
          </pre>
        ),
      )}
      {toolCalls != null && toolCalls.length > 0 && (
        <div className="mt-2 rounded border border-gray-200 bg-white p-2">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Tool calls
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-gray-700">
            {JSON.stringify(toolCalls, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-lg border bg-gray-50 p-3 font-mono text-xs text-gray-800">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-white px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-gray-900">{value}</p>
    </div>
  )
}

export function AgentRunDetailClient() {
  const searchParams = useSearchParams()
  const runId = searchParams.get('run') ?? ''

  const { getIdToken } = useAuth()
  const client = useMemo(() => createApiClient(getIdToken), [getIdToken])

  const [run, setRun] = useState<AgentRunResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (runId === '') {
      setError('No run selected.')
      return
    }
    try {
      const record = await fetchAgentRun(client, runId)
      setRun(record)
      setError(null)
    } catch (err: unknown) {
      setError(errorMessage(err))
    }
  }, [client, runId])

  useEffect(() => {
    void load()
  }, [load])

  if (error != null) {
    return (
      <div>
        <Link href="/admin/agent-runs/" className="text-sm text-indigo-700 hover:underline">
          ← Back to agent runs
        </Link>
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    )
  }

  if (run == null) {
    return (
      <div className="space-y-2" aria-label="Loading agent run">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-gray-100" />
        ))}
      </div>
    )
  }

  return (
    <div>
      <Link href="/admin/agent-runs/" className="text-sm text-indigo-700 hover:underline">
        ← Back to agent runs
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-gray-900">{run.agent_name}</h1>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            statusClass[run.status] ?? 'bg-gray-100 text-gray-600'
          }`}
        >
          {run.status}
        </span>
      </div>
      <p className="mt-1 font-mono text-xs text-gray-400">{run.id}</p>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Input tokens" value={run.input_tokens?.toLocaleString() ?? '—'} />
        <Stat label="Output tokens" value={run.output_tokens?.toLocaleString() ?? '—'} />
        <Stat label="Cost" value={formatCost(run.cost_usd)} />
        <Stat label="Depth" value={String(run.depth)} />
        <Stat label="Started" value={formatWhen(run.started_at)} />
        <Stat label="Completed" value={formatWhen(run.completed_at)} />
        {run.prompt_version != null && (
          <Stat label="Prompt version" value={String(run.prompt_version)} />
        )}
      </div>

      {run.error != null && run.error !== '' && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-rose-700">Error</h2>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {run.error}
          </pre>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900">Conversation</h2>
        <p className="mt-1 text-sm text-gray-600">
          The message array the model was actually sent. Blocks fenced as{' '}
          <span className="font-mono text-xs">untrusted</span> are data the runtime told the model
          not to treat as instructions.
        </p>
        {run.messages.length === 0 ? (
          <p className="mt-4 text-sm text-gray-400">No messages recorded.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {run.messages.map((message, i) => (
              <MessageCard key={i} message={message} index={i} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900">Result</h2>
        {run.result == null ? (
          <p className="mt-2 text-sm text-gray-400">No result recorded.</p>
        ) : (
          <div className="mt-2">
            <JsonBlock value={run.result} />
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900">Definition snapshot</h2>
        <p className="mt-1 text-sm text-gray-600">
          The resolved definition this run executed, captured verbatim (ADR-0014 §10) — this is what
          makes the run self-explaining, e.g. the exact model it ran on.
        </p>
        <div className="mt-2">
          <JsonBlock value={run.definition_snapshot} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900">Input payload</h2>
        <div className="mt-2">
          <JsonBlock value={run.input_payload} />
        </div>
      </section>
    </div>
  )
}
