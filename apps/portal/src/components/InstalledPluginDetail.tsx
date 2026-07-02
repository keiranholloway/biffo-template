'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/context/auth-context'
import { createApiClient } from '@/lib/api-client'
import { fetchInstalledPlugins, type InstalledPlugin } from '@/lib/plugin-api'

interface InstalledPluginDetailProps {
  name: string
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'not-found' }
  | { status: 'found'; plugin: InstalledPlugin }

/**
 * Detail view for a plugin discovered on this deployment (GET
 * /admin/plugins/available), as opposed to PluginDetail.tsx which looks up
 * the external marketplace registry. These are two different data sources
 * with overlapping but not identical name spaces — an installed plugin like
 * services/rbac is a local reference implementation, never published to
 * keiranholloway/biffo-plugins-registry, so it would incorrectly show
 * "not found" if routed through the marketplace lookup instead of this one.
 *
 * Re-fetches the full installed-plugins list and finds by name rather than
 * having a dedicated GET /admin/plugins/available/{name} endpoint — mirrors
 * PluginDetail.tsx's own fetchPluginBySlug pattern (fetch the whole
 * registry, find by name), and there's no single-plugin endpoint on the
 * Core API today to call instead.
 */
export function InstalledPluginDetail({ name }: InstalledPluginDetailProps) {
  const { getIdToken } = useAuth()
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })

    const client = createApiClient(getIdToken)
    fetchInstalledPlugins(client)
      .then((plugins) => {
        if (cancelled) return
        const plugin = plugins.find((p) => p.name === name)
        setState(plugin === undefined ? { status: 'not-found' } : { status: 'found', plugin })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Unknown error',
        })
      })

    return () => {
      cancelled = true
    }
  }, [name, getIdToken])

  if (state.status === 'loading') {
    return (
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <div className="h-6 w-48 animate-pulse rounded bg-gray-200" />
        <div className="mt-3 h-4 w-full max-w-md animate-pulse rounded bg-gray-200" />
        <div className="mt-2 h-4 w-2/3 max-w-sm animate-pulse rounded bg-gray-200" />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6">
        <h1 className="text-lg font-semibold text-red-800">Could not load installed plugins</h1>
        <p className="mt-1 text-sm text-red-700">{state.message}</p>
      </div>
    )
  }

  if (state.status === 'not-found') {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
        <h1 className="text-lg font-semibold text-gray-900">
          Plugin &ldquo;{name}&rdquo; is not installed
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          It isn&apos;t discoverable under this deployment&apos;s{' '}
          <code className="font-mono">services/</code> directory. It may have been removed since
          this list was loaded.
        </p>
        <Link
          href="/admin/plugins"
          className="mt-4 inline-block text-sm font-medium text-blue-600 hover:underline"
        >
          Back to installed plugins
        </Link>
      </div>
    )
  }

  const { plugin } = state

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-gray-900">{plugin.name}</h1>
        <p className="mt-1 text-sm text-gray-500">v{plugin.version}</p>

        {plugin.description !== '' && (
          <p className="mt-4 text-sm text-gray-700">{plugin.description}</p>
        )}
      </div>

      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900">Tables ({plugin.tables.length})</h2>
        {plugin.tables.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No tables declared.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {plugin.tables.map((table) => (
              <li key={table.name} className="rounded-lg bg-gray-50 px-3 py-2">
                <code className="font-mono text-sm text-gray-800">{table.name}</code>
                <span className="ml-2 text-xs text-gray-400">
                  {table.columns.length} {table.columns.length === 1 ? 'column' : 'columns'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900">Routes ({plugin.routes.length})</h2>
        {plugin.routes.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No routes declared.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {plugin.routes.map((route) => (
              <li
                key={`${route.method} ${route.path}`}
                className="flex items-center gap-3 rounded-lg bg-gray-50 px-3 py-2"
              >
                <span className="shrink-0 rounded bg-gray-900 px-2 py-0.5 font-mono text-xs font-medium text-white">
                  {route.method}
                </span>
                <code className="font-mono text-sm text-gray-800">{route.path}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
