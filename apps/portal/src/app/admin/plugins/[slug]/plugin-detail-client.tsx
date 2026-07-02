'use client'

import { useParams } from 'next/navigation'
import { PluginDetail } from '@/components/PluginDetail'

/**
 * `generateStaticParams()` can only be exported from a server component
 * (page.tsx), while reading the *actual* browser URL requires the client
 * hook `useParams()` — Next.js forbids combining `"use client"` and
 * `generateStaticParams()` in the same file. So the split is: page.tsx
 * (server) declares the one static param needed to satisfy `output: 'export'`,
 * and this client component resolves the real slug at runtime via
 * `useParams()`, which reflects the actual URL matched against the compiled
 * route table — not whatever placeholder was baked in at build time. See
 * the comment in page.tsx for the full static-export rationale.
 */
export function PluginDetailPageClient() {
  const params = useParams<{ slug: string }>()
  const slug = params.slug

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Plugin</h1>
      <div className="mt-6">
        <PluginDetail slug={slug} />
      </div>
    </div>
  )
}
