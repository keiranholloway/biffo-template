import { PluginDetailPageClient } from './plugin-detail-client'

/**
 * `output: 'export'` (see next.config.ts) requires every dynamic segment to
 * declare `generateStaticParams()` at build time — but the plugin registry
 * is fetched at runtime from an external repo (`keiranholloway/biffo-plugins-registry`),
 * so the real set of slugs isn't knowable at build time. There's no other
 * dynamic-route precedent in this app to follow (checked `apps/portal/src/app/**`
 * — every existing page is static) and every page here is already a client
 * component that fetches its own data on mount, so this route follows the
 * same pattern: export exactly one placeholder static shell (satisfying the
 * static-export build requirement) and resolve the *real* slug client-side
 * in `plugin-detail-client.tsx` via `useParams()`, which reflects the actual
 * browser URL matched against the compiled route table, not the placeholder
 * baked in here at build time. (`generateStaticParams()` must live in a
 * server component — it can't be exported from a `"use client"` file —
 * hence the split between this file and plugin-detail-client.tsx.)
 *
 * Caveat: direct hard-navigation/refresh to a real slug depends on
 * CloudFront's existing 403/404 -> /index.html fallback
 * (modules/cloud/aws/cdn) — today that lands on the portal home page rather
 * than this shell, since the fallback isn't scoped per-route. Fixing that
 * is a CDN/infra change outside this issue's file scope (see PR
 * description). Client-side navigation from the marketplace/installed pages
 * (#22/#23, via next/link) is unaffected — it never leaves the loaded SPA,
 * so it always reaches this component.
 */
export function generateStaticParams() {
  return [{ slug: 'placeholder' }]
}

export default function PluginDetailPage() {
  return <PluginDetailPageClient />
}
