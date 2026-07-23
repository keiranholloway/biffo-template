import { Suspense } from 'react'
import { AgentRunDetailClient } from './agent-run-detail-client'

/**
 * `output: 'export'` (see next.config.ts) requires every dynamic segment to
 * declare `generateStaticParams()` at build time, and a client-side `next/link`
 * navigation to a path segment that was NOT statically generated does not stay
 * in the SPA — it falls back to a full browser navigation that 404s against the
 * exported `out/` directory, which CloudFront's error fallback then rewrites to
 * the portal home page (or, per #275, lands on a raw RSC `.txt` payload). A
 * dynamic `[slug]` enumerating real run ids at build time cannot work anyway:
 * runs are created at runtime, long after the export is built.
 *
 * Fix, identical to admin/plugins/[slug]: generate exactly ONE placeholder
 * segment, and carry the real run id as a query string (`?run=<id>`). A query
 * string does not change which static asset CloudFront serves, so
 * `/admin/agent-runs/placeholder/` is always a real navigation target
 * regardless of which run was clicked; the client component reads the id via
 * `useSearchParams()`.
 */
export function generateStaticParams() {
  return [{ slug: 'placeholder' }]
}

export default function AgentRunDetailPage() {
  // useSearchParams() (in AgentRunDetailClient) opts this statically
  // prerendered page out of static rendering unless wrapped in Suspense --
  // Next.js requirement: https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout
  return (
    <Suspense fallback={null}>
      <AgentRunDetailClient />
    </Suspense>
  )
}
