'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  derivePluginAdminHref,
  humanizePluginName,
  isValidPluginName,
} from '@/lib/plugin-nav-contract'

export function PluginPanelClient() {
  const name = useSearchParams().get('name')?.trim() ?? ''

  if (!isValidPluginName(name)) {
    return (
      <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
        No plugin selected.{' '}
        <Link href="/admin/" className="underline">
          Back to the portal
        </Link>
      </div>
    )
  }

  return (
    <iframe
      key={name}
      title={`${humanizePluginName(name)} admin`}
      src={derivePluginAdminHref(name)}
      className="h-[75vh] w-full rounded-lg border bg-white"
    />
  )
}
