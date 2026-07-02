'use client'

import { useEffect, useMemo, useState } from 'react'
import { PluginCard } from '@/components/PluginCard'
import { fetchActivePlugins, PluginRegistryError, type RegistryPlugin } from '@/lib/plugin-api'

export default function MarketplacePage() {
  const [plugins, setPlugins] = useState<RegistryPlugin[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedTag, setSelectedTag] = useState<string | null>(null)

  useEffect(() => {
    fetchActivePlugins()
      .then(setPlugins)
      .catch((err: unknown) => {
        setError(
          err instanceof PluginRegistryError ? err.message : 'Failed to load the plugin registry.',
        )
      })
  }, [])

  const tags = useMemo(() => {
    const seen = new Set<string>()
    for (const plugin of plugins ?? []) {
      for (const tag of plugin.tags ?? []) seen.add(tag)
    }
    return Array.from(seen).sort()
  }, [plugins])

  const filteredPlugins = useMemo(() => {
    if (plugins == null) return []
    const query = search.trim().toLowerCase()
    return plugins.filter((plugin) => {
      const matchesQuery =
        query === '' ||
        plugin.name.toLowerCase().includes(query) ||
        (plugin.description ?? '').toLowerCase().includes(query)
      const matchesTag = selectedTag == null || (plugin.tags ?? []).includes(selectedTag)
      return matchesQuery && matchesTag
    })
  }, [plugins, search, selectedTag])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Marketplace</h1>
      <p className="mt-1 text-sm text-gray-600">
        Browse plugins published to the Biffo plugin registry.
      </p>

      {error != null && (
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {error == null && plugins == null && (
        <div
          className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="marketplace-loading"
        >
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-xl border bg-white p-6 shadow-sm">
              <div className="h-4 w-32 animate-pulse rounded bg-gray-200" />
              <div className="mt-3 h-3 w-full animate-pulse rounded bg-gray-200" />
              <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-gray-200" />
            </div>
          ))}
        </div>
      )}

      {error == null && plugins != null && plugins.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-600">No plugins available yet</p>
          <p className="mt-1 text-xs text-gray-400">
            Check back soon, or publish a plugin to the registry.
          </p>
        </div>
      )}

      {error == null && plugins != null && plugins.length > 0 && (
        <>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
              }}
              placeholder="Search plugins..."
              aria-label="Search plugins"
              className="w-full rounded-lg border px-3 py-2 text-sm sm:max-w-xs"
            />

            {tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedTag(null)
                  }}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    selectedTag == null ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  All
                </button>
                {tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => {
                      setSelectedTag(tag)
                    }}
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      selectedTag === tag ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>

          {filteredPlugins.length === 0 ? (
            <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
              <p className="text-sm font-medium text-gray-600">No plugins match your search</p>
            </div>
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {filteredPlugins.map((plugin) => (
                <PluginCard key={plugin.name} plugin={plugin} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
