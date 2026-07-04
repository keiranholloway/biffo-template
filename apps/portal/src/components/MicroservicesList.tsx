'use client'

import { useEffect, useState } from 'react'
import { type Sibling, fetchSiblings, siblingHref, siblingRouteHref } from '@/lib/siblings-api'

/**
 * The Microservices tab (ADR-0007): the sibling apps registered for this
 * project, each linking to its live path (`/<name>`, no trailing slash). Data
 * comes from the static `siblings.json` baked in at deploy time.
 */
export function MicroservicesList() {
  const [siblings, setSiblings] = useState<Sibling[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchSiblings()
      .then(setSiblings)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Unknown error')
      })
  }, [])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Microservices</h1>
      <p className="mt-1 text-sm text-gray-600">
        The sibling apps deployed for this project. Each runs at its own path on this domain.
      </p>

      {error != null && (
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {siblings == null && error == null && (
        <div className="mt-6 space-y-2" aria-label="Loading microservices">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-gray-100" />
          ))}
        </div>
      )}

      {siblings != null && siblings.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-600">No microservices yet</p>
          <p className="mt-1 text-xs text-gray-400">
            Create one with <code className="font-mono">biffo sibling create</code> (ADR-0007).
          </p>
        </div>
      )}

      {siblings != null && siblings.length > 0 && (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {siblings.map((s) => (
            <li
              key={s.name}
              className="flex h-full flex-col rounded-xl border bg-white p-4 shadow-sm transition hover:border-gray-400 hover:shadow"
            >
              <div className="flex items-center justify-between">
                <a href={siblingHref(s.name)} className="font-medium text-gray-900 hover:underline">
                  {s.name}
                </a>
                <a href={siblingHref(s.name)} className="text-sm text-blue-600 hover:underline">
                  Open →
                </a>
              </div>
              {s.description !== '' && (
                <p className="mt-2 text-sm text-gray-600">{s.description}</p>
              )}
              {s.routes && s.routes.length > 0 ? (
                <ul className="mt-3 space-y-1 border-t border-gray-100 pt-3">
                  {s.routes.map((r) => (
                    <li key={r.path}>
                      <a
                        href={siblingRouteHref(s.name, r.path)}
                        className="flex items-baseline justify-between gap-2 text-sm text-gray-700 hover:text-blue-600"
                      >
                        <span>{r.label}</span>
                        <code className="font-mono text-xs text-gray-400">
                          {siblingRouteHref(s.name, r.path)}
                        </code>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <code className="mt-3 font-mono text-xs text-gray-400">{siblingHref(s.name)}</code>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
