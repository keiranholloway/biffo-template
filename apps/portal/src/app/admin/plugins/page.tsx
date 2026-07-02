'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { createApiClient } from '@/lib/api-client'
import { fetchInstalledPlugins, type InstalledPlugin } from '@/lib/plugin-api'
import { InstalledPluginRow } from '@/components/InstalledPluginRow'

export default function PluginsPage() {
  const { getIdToken } = useAuth()
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const client = createApiClient(getIdToken)
    fetchInstalledPlugins(client)
      .then(setPlugins)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Unknown error')
      })
  }, [getIdToken])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Installed plugins</h1>
      <p className="mt-1 text-sm text-gray-600">
        Plugins discovered from this deployment&apos;s <code className="font-mono">services/</code>{' '}
        directory.
      </p>

      {error != null && (
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {plugins == null && error == null && (
        <ul className="mt-6 space-y-4" aria-label="Loading installed plugins">
          {[0, 1].map((i) => (
            <li key={i} className="rounded-xl border bg-white p-6 shadow-sm">
              <div className="h-4 w-40 animate-pulse rounded bg-gray-200" />
              <div className="mt-2 h-3 w-64 animate-pulse rounded bg-gray-200" />
            </li>
          ))}
        </ul>
      )}

      {plugins != null && plugins.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-600">No plugins installed yet</p>
          <p className="mt-1 text-xs text-gray-400">
            Install a plugin under <code className="font-mono">services/</code> (see{' '}
            <code className="font-mono">services/rbac</code> for a reference implementation) and it
            will appear here automatically.
          </p>
        </div>
      )}

      {plugins != null && plugins.length > 0 && (
        <ul className="mt-6 space-y-4">
          {plugins.map((plugin) => (
            <InstalledPluginRow key={plugin.name} plugin={plugin} />
          ))}
        </ul>
      )}
    </div>
  )
}
