'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { createApiClient } from '@/lib/api-client'
import { type Endpoint, fetchEndpoints } from '@/lib/endpoint-api'

const METHOD_COLOR: Record<string, string> = {
  GET: 'bg-sky-100 text-sky-700',
  POST: 'bg-emerald-100 text-emerald-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-amber-100 text-amber-700',
  DELETE: 'bg-rose-100 text-rose-700',
}

function RoleCell({ roles }: { roles: string[] }) {
  if (roles.length === 0) {
    return <span className="text-xs text-gray-400">any authenticated</span>
  }
  return (
    <span className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <span key={r} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700">
          {r}
        </span>
      ))}
    </span>
  )
}

export default function EndpointsPage() {
  const { getIdToken } = useAuth()
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const client = createApiClient(getIdToken)
    fetchEndpoints(client)
      .then(setEndpoints)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Unknown error')
      })
  }, [getIdToken])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Endpoints</h1>
      <p className="mt-1 text-sm text-gray-600">
        The live generic-CRUD endpoints on this deployment and the role each requires. Read-only —
        to enable or change one, edit its <code className="font-mono">permissions</code> and deploy
        (see the guide).
      </p>

      {error != null && (
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {endpoints == null && error == null && (
        <div className="mt-6 space-y-2" aria-label="Loading endpoints">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      )}

      {endpoints != null && endpoints.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-600">No endpoints exposed yet</p>
          <p className="mt-1 text-xs text-gray-400">
            Add a <code className="font-mono">permissions</code> block to a plugin table, or{' '}
            <code className="font-mono">__crud_permissions__</code> to a core model, then deploy.
          </p>
        </div>
      )}

      {endpoints != null && endpoints.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Method</th>
                <th className="px-4 py-2">Path</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {endpoints.map((e) => (
                <tr key={`${e.method} ${e.path}`}>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-xs font-semibold ${
                        METHOD_COLOR[e.method] ?? 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {e.method}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-800">{e.path}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {e.source === 'plugin' ? (
                      <>
                        plugin <span className="font-medium text-gray-800">{e.plugin}</span>
                      </>
                    ) : (
                      'core'
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <RoleCell roles={e.required_role} />
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
