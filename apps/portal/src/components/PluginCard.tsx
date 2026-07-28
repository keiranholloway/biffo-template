import Link from 'next/link'
import type { RegistryPlugin } from '@/lib/plugin-api'

export function PluginCard({ plugin }: { plugin: RegistryPlugin }) {
  const isBuiltIn = plugin.tags?.includes('built-in') ?? false

  return (
    // Not a Link wrapping the whole card any more: the card now contains a
    // second link (the source repo), and an <a> inside an <a> is invalid HTML
    // that React reports as a hydration error. Instead the heading owns the
    // navigation and stretches its hit area over the whole card via
    // `after:absolute after:inset-0`, and the repo link sits above that
    // overlay with `relative z-10`. Same click-anywhere behaviour, one
    // accessible link per destination.
    <div className="relative flex flex-col rounded-xl border bg-white p-6 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-medium text-gray-900">
          <Link
            href={`/admin/plugins/placeholder?source=marketplace&name=${encodeURIComponent(plugin.name)}`}
            className="after:absolute after:inset-0 after:content-['']"
          >
            {plugin.name}
          </Link>
        </h2>
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
              className={
                tag === 'built-in'
                  ? 'rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700'
                  : 'rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700'
              }
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-end justify-between gap-3">
        <p className="text-xs text-gray-400">
          By {plugin.author ?? 'Biffo Team'}
          {isBuiltIn && <span className="block">Ships with Biffo core</span>}
        </p>

        {plugin.repo !== '' && (
          <a
            href={plugin.repo}
            target="_blank"
            rel="noopener noreferrer"
            // Above the heading's stretched ::after overlay, or the card
            // navigation would swallow this click.
            className="relative z-10 shrink-0 text-xs font-medium text-blue-600 hover:underline"
          >
            View source ↗
          </a>
        )}
      </div>
    </div>
  )
}
