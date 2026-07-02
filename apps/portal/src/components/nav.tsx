'use client'

import Link from 'next/link'
import { useAuth } from '@/context/auth-context'
import { Button } from '@biffo/ui'

export function Nav() {
  const { session, logout } = useAuth()
  const username = session?.getIdToken().decodePayload()['cognito:username'] as string | undefined

  return (
    <nav className="flex items-center justify-between border-b px-6 py-4">
      <div className="flex items-center gap-6">
        <span className="text-lg font-semibold">Biffo Portal</span>
        <Link href="/admin/marketplace" className="text-sm text-gray-600 hover:text-gray-900">
          Marketplace
        </Link>
        <Link href="/admin/plugins" className="text-sm text-gray-600 hover:text-gray-900">
          Plugins
        </Link>
      </div>
      <div className="flex items-center gap-4">
        {username != null && <span className="text-sm text-gray-600">{username}</span>}
        <Button variant="secondary" onClick={logout} className="text-sm">
          Sign out
        </Button>
      </div>
    </nav>
  )
}
