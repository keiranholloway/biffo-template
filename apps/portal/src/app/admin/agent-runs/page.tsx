'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { createApiClient } from '@/lib/api-client'
import { fetchAgentRuns, type AgentRunSummary, type AgentRunFilters } from '@/lib/agent-runs-api'
import { formatCost, formatDuration, formatWhen } from '@/lib/agent-runs-format'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}

// Terminal states carry the strongest signal: failure reads red, success green.
// A run still in flight (pending/running) stays neutral.
const statusClass: Record<string, string> = {
  completed: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-rose-100 text-rose-700',
  running: 'bg-sky-100 text-sky-700',
  pending: 'bg-gray-100 text-gray-600',
}

// Mirrors AGENT_RUN_STATUSES in services/api/src/api/models/agent_run.py.
const STATUSES = ['pending', 'running', 'completed', 'failed'] as const

const inputClass = 'mt-1 rounded border px-2 py-1 text-sm'

/** The detail route is a single statically-generated placeholder page; the run
 *  id travels as a query param (see admin/agent-runs/[slug]/page.tsx). Mirrors
 *  the plugins-list convention (PluginCard): `placeholder?run=…`, which Next
 *  resolves against the exported `placeholder/index.html` under
 *  `trailingSlash: true`. */
function detailHref(runId: string): string {
  return `/admin/agent-runs/placeholder?run=${encodeURIComponent(runId)}`
}

export default function AgentRunsPage() {
  const { getIdToken } = useAuth()
  const client = useMemo(() => createApiClient(getIdToken), [getIdToken])

  const [runs, setRuns] = useState<AgentRunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [agentName, setAgentName] = useState('')
  const [status, setStatus] = useState('')

  const reload = useCallback(
    async (filters: AgentRunFilters) => {
      setRuns(null)
      try {
        const rows = await fetchAgentRuns(client, filters)
        setRuns(rows)
        setError(null)
      } catch (err: unknown) {
        setError(errorMessage(err))
      }
    },
    [client],
  )

  useEffect(() => {
    void reload({})
  }, [reload])

  function applyFilters() {
    void reload({
      agent_name: agentName.trim() === '' ? undefined : agentName.trim(),
      status: status === '' ? undefined : status,
    })
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Agent runs</h1>
      <p className="mt-1 text-sm text-gray-600">
        Every agentic-worker run this tenant has recorded — what fired, which model, how much it
        cost, and whether it finished. Open a run to read its full transcript.
      </p>

      {error != null && (
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          applyFilters()
        }}
        className="mt-6 flex flex-wrap items-end gap-3"
      >
        <label className="flex flex-col text-xs text-gray-600">
          Agent name
          <input
            aria-label="Filter by agent name"
            value={agentName}
            onChange={(e) => {
              setAgentName(e.target.value)
            }}
            placeholder="demo-enricher"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col text-xs text-gray-600">
          Status
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
            }}
            className={inputClass}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
      </form>

      {runs == null && error == null && (
        <div className="mt-6 space-y-2" aria-label="Loading agent runs">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      )}

      {runs != null && runs.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-600">No agent runs</p>
          <p className="mt-1 text-xs text-gray-400">
            Runs appear here once an agentic worker executes.
          </p>
        </div>
      )}

      {runs != null && runs.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Agent</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2">Duration</th>
                <th className="px-4 py-2">Model</th>
                <th className="px-4 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-800">
                    <Link href={detailHref(run.id)} className="text-indigo-700 hover:underline">
                      {run.agent_name}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        statusClass[run.status] ?? 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                    {formatWhen(run.created_at)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                    {formatDuration(run.started_at, run.completed_at)}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {run.model ?? <span className="text-gray-400">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right text-gray-600">
                    {formatCost(run.cost_usd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
