import Link from 'next/link'
import type { InstalledPlugin } from '@/lib/plugin-api'

/**
 * One row in the installed-plugins list.
 *
 * Shows only fields the real GET /admin/plugins/available response actually
 * returns (name, version, description, table/route counts) — no
 * enable/disable toggle, status badge, or "last updated" timestamp, since
 * none of those exist in the API today. See the plugins page for the full
 * scope note.
 */
export function InstalledPluginRow({ plugin }: { plugin: InstalledPlugin }) {
  const tableCount = plugin.tables.length
  const routeCount = plugin.routes.length

  return (
    <li className="rounded-xl border bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-medium text-gray-900">{plugin.name}</h2>
            <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
              v{plugin.version}
            </span>
          </div>
          {plugin.description !== '' && (
            <p className="mt-1 text-sm text-gray-600">{plugin.description}</p>
          )}
          <p className="mt-3 text-xs text-gray-400">
            {tableCount} {tableCount === 1 ? 'table' : 'tables'} · {routeCount}{' '}
            {routeCount === 1 ? 'route' : 'routes'}
          </p>
        </div>
        <Link
          href={`/admin/plugins/placeholder?source=installed&name=${encodeURIComponent(plugin.name)}`}
          className="shrink-0 text-sm font-medium text-blue-600 hover:text-blue-800"
        >
          View details &rarr;
        </Link>
      </div>
    </li>
  )
}
