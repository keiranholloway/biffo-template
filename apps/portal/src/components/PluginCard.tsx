import Link from 'next/link'
import type { RegistryPlugin } from '@/lib/plugin-api'

export function PluginCard({ plugin }: { plugin: RegistryPlugin }) {
  return (
    <Link
      href={`/admin/plugins/placeholder?source=marketplace&name=${encodeURIComponent(plugin.name)}`}
      className="flex flex-col rounded-xl border bg-white p-6 shadow-sm transition hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-medium text-gray-900">{plugin.name}</h2>
        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
          v{plugin.version}
        </span>
      </div>

      {plugin.description != null && plugin.description !== '' && (
        <p className="mt-2 text-sm text-gray-600">{plugin.description}</p>
      )}

      {plugin.tags != null && plugin.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {plugin.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <p className="mt-4 text-xs text-gray-400">By {plugin.author ?? 'Biffo Team'}</p>
    </Link>
  )
}
