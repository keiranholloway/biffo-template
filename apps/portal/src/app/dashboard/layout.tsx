import type { ReactNode } from 'react'
import { Nav } from '@/components/nav'
import { AuthGuard } from '@/components/auth-guard'

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-gray-50">
        <Nav />
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      </div>
    </AuthGuard>
  )
}
