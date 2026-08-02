import type { ReactNode } from 'react'
import { Nav } from '@/components/nav'
import { AuthGuard } from '@/components/auth-guard'
import { ADMIN_GROUP } from '@/lib/cognito-groups'

/**
 * Every route in this subtree is an infrastructure console: microservices,
 * plugins, endpoints, users, workflows, agent runs. ADR-0100 is explicit that
 * /admin/ is the wrong destination for anyone who is not an administrator, so
 * the requirement is declared once here rather than per page — a new page
 * dropped under /admin/ inherits it and cannot forget to ask (#1104).
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard requireGroup={ADMIN_GROUP}>
      <div className="min-h-screen bg-gray-50">
        <Nav />
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      </div>
    </AuthGuard>
  )
}
