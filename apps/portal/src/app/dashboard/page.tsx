'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/context/auth-context'
import { createApiClient } from '@/lib/api-client'

interface UserProfile {
  id: string
  email: string
  username: string
  created_at: string
  last_login_at: string | null
}

export default function DashboardPage() {
  const { getIdToken } = useAuth()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const client = createApiClient(getIdToken)
    client
      .get<UserProfile>('/api/v1/auth/me')
      .then(setProfile)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Unknown error')
      })
  }, [getIdToken])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      {error != null && (
        <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {profile != null && (
        <div className="mt-6 rounded-xl border bg-white p-6 shadow-sm">
          <p className="text-lg font-medium">Welcome, {profile.username}!</p>
          <p className="mt-1 text-sm text-gray-600">{profile.email}</p>
          <p className="mt-4 text-xs text-gray-400">
            Member since {new Date(profile.created_at).toLocaleDateString()}
          </p>
        </div>
      )}

      {profile == null && error == null && (
        <div className="mt-6 rounded-xl border bg-white p-6 shadow-sm">
          <div className="h-4 w-48 animate-pulse rounded bg-gray-200" />
          <div className="mt-2 h-3 w-32 animate-pulse rounded bg-gray-200" />
        </div>
      )}

      <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
        <p className="text-sm font-medium text-gray-600">Your application goes here</p>
        <p className="mt-1 text-xs text-gray-400">
          Build microservices in <code className="font-mono">services/</code> and wire them to this
          portal
        </p>
      </div>
    </div>
  )
}
