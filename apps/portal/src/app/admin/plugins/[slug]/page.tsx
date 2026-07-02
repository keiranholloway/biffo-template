import { Suspense } from 'react'
import { PluginDetailPageClient } from './plugin-detail-client'

/**
 * `output: 'export'` (see next.config.ts) requires every dynamic segment to
 * declare `generateStaticParams()` at build time, and — this is the part
 * the original version of this file got wrong — a client-side `next/link`
 * navigation to a path segment that wasn't statically generated does NOT
 * stay in the SPA. Verified directly: it falls back to a full browser
 * navigation, which 404s against the exported `out/` directory, which
 * CloudFront's error-response fallback (modules/cloud/aws/cdn) then
 * rewrites to the portal home page — "clicking a plugin bounces me back to
 * the home page" was that fallback chain end to end, not a CDN
 * misconfiguration.
 *
 * Fix: never generate a second path segment at all. Every plugin (marketplace
 * or installed) links to this exact one statically-generated path —
 * `/admin/plugins/placeholder/` — and carries the real identifying info
 * (`source`, `name`) as a query string instead. A query string doesn't
 * change which static asset CloudFront serves, so this path is always a real
 * navigation target regardless of which plugin was clicked; the client
 * component below reads the actual values via `useSearchParams()`.
 */
export function generateStaticParams() {
  return [{ slug: 'placeholder' }]
}

export default function PluginDetailPage() {
  // useSearchParams() (in PluginDetailPageClient) opts this statically
  // prerendered page out of static rendering unless wrapped in Suspense --
  // Next.js requirement, not specific to this route: https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout
  return (
    <Suspense fallback={null}>
      <PluginDetailPageClient />
    </Suspense>
  )
}
