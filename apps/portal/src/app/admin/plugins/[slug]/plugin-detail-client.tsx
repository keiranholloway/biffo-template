'use client'

import { useSearchParams } from 'next/navigation'
import { PluginDetail } from '@/components/PluginDetail'
import { InstalledPluginDetail } from '@/components/InstalledPluginDetail'

/**
 * `generateStaticParams()` can only be exported from a server component
 * (page.tsx); resolving the real plugin identity at runtime requires client
 * hooks, hence the split between that file (server) and this one (client).
 * See page.tsx's comment for why the identity travels as `?source=&name=`
 * query params rather than the `[slug]` path segment itself — every plugin
 * links to the exact same statically-generated path, so this component
 * never sees a meaningful `slug` param; it reads `useSearchParams()`
 * instead, which reflects the actual URL regardless of what was baked in
 * at build time.
 *
 * `source` distinguishes two genuinely different data sources sharing this
 * one route: `installed` (this deployment's own services/*, via
 * InstalledPluginDetail) and `marketplace` (the external
 * biffo-plugins-registry, via PluginDetail) — an installed plugin
 * like services/orchestrator is never published to the marketplace registry, so
 * routing it through the marketplace lookup would incorrectly show
 * "not found".
 */
export function PluginDetailPageClient() {
  const searchParams = useSearchParams()
  const name = searchParams.get('name') ?? ''
  const source = searchParams.get('source') ?? 'marketplace'

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Plugin</h1>
      <div className="mt-6">
        {source === 'installed' ? (
          <InstalledPluginDetail name={name} />
        ) : (
          <PluginDetail slug={name} />
        )}
      </div>
    </div>
  )
}
