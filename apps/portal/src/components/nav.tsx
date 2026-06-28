'use client'

import { useAuth } from '@/context/auth-context'
import { Button } from '@biffo/ui'

export function Nav() {
  const { session, logout } = useAuth()
  const username = session?.getIdToken().decodePayload()['cognito:username'] as string | undefined

  return (
    <nav className="flex items-center justify-between border-b px-6 py-4">
      <span className="text-lg font-semibold">Biffo Portal</span>
      <div className="flex items-center gap-4">
        {username != null && <span className="text-sm text-gray-600">{username}</span>}
        <Button variant="secondary" onClick={logout} className="text-sm">
          Sign out
        </Button>
      </div>
    </nav>
  )
}
