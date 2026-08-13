'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/context/auth-context'
import { INSTANCE_NAV_LINKS } from '@/instance-nav'
import { createApiClient } from '@/lib/api-client'
import { PORTAL_TITLE } from '@/lib/branding'
import { sessionGroups } from '@/lib/cognito-groups'
import { resolveInstanceNavLinks } from '@/lib/instance-nav-contract'
import { fetchInstalledPlugins } from '@/lib/plugin-api'
import { type PluginNavLink, resolvePluginNavLinks } from '@/lib/plugin-nav-contract'
import { Button } from '@biffo/ui'

export function Nav() {
  const { session, logout, getIdToken } = useAuth()
  // The email address, not `cognito:username`. The pool uses
  // username_attributes = ["email"], so Cognito generates the username as an
  // opaque UUID — showing it here would put a meaningless id where the signed-in
  // person's identity belongs.
  const email = session?.getIdToken().decodePayload()['email'] as string | undefined

  // Plugin nav entries (issue #1555). Unlike the instance registry above,
  // this is runtime data — which plugins are installed, and what their
  // admin surfaces are gated behind, are properties of the deployment, not
  // build-time constants — so it has to be fetched client-side rather than
  // imported. See plugin-nav-contract.ts's module docstring for the full
  // reasoning, including why the portal's static export forces this.
  const [pluginLinks, setPluginLinks] = useState<PluginNavLink[]>([])

  useEffect(() => {
    if (session == null) {
      setPluginLinks([])
      return
    }
    let cancelled = false
    const client = createApiClient(getIdToken)
    fetchInstalledPlugins(client)
      .then((plugins) => {
        if (!cancelled) setPluginLinks(resolvePluginNavLinks(plugins, sessionGroups(session)))
      })
      .catch(() => {
        // Fail-soft, same posture as resolvePluginNavLinks itself: an
        // unreachable/erroring listing renders no plugin links rather than
        // taking the whole nav down.
        if (!cancelled) setPluginLinks([])
      })
    return () => {
      cancelled = true
    }
  }, [session, getIdToken])

  return (
    <nav className="flex items-center justify-between border-b px-6 py-4">
      <div className="flex items-center gap-6">
        <span className="text-lg font-semibold">{PORTAL_TITLE}</span>
        <Link href="/admin/microservices/" className="text-sm text-gray-600 hover:text-gray-900">
          Microservices
        </Link>
        <Link href="/admin/marketplace/" className="text-sm text-gray-600 hover:text-gray-900">
          Marketplace
        </Link>
        <Link href="/admin/plugins/" className="text-sm text-gray-600 hover:text-gray-900">
          Plugins
        </Link>
        <Link href="/admin/endpoints/" className="text-sm text-gray-600 hover:text-gray-900">
          Endpoints
        </Link>
        <Link href="/admin/users/" className="text-sm text-gray-600 hover:text-gray-900">
          Users
        </Link>
        <Link href="/admin/orchestration/" className="text-sm text-gray-600 hover:text-gray-900">
          Workflows
        </Link>
        <Link href="/admin/agent-runs/" className="text-sm text-gray-600 hover:text-gray-900">
          Agent runs
        </Link>
        <Link
          href="/admin/prompt-components/"
          className="text-sm text-gray-600 hover:text-gray-900"
        >
          Prompt library
        </Link>
        {/*
         * An instance's OWN admin surfaces (ADR-0028). Declared in the
         * user-owned `@/instance-nav`, rendered after the core links, so
         * adding one never requires patching this template-owned file. The
         * base template declares none, so this renders nothing.
         */}
        {resolveInstanceNavLinks(INSTANCE_NAV_LINKS).map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            {link.label}
          </Link>
        ))}
        {/*
         * Installed plugins' declared admin surfaces (issue #1555). Renders
         * after the instance's own links, using a plain `<a>` rather than
         * `next/link`: the target is served by the shared plugin host
         * through the API, not by this static export, so client-side
         * routing (and its trailing-slash normalisation) doesn't apply.
         */}
        {pluginLinks.map((link) => (
          <a key={link.href} href={link.href} className="text-sm text-gray-600 hover:text-gray-900">
            {link.label}
          </a>
        ))}
      </div>
      <div className="flex items-center gap-4">
        {email != null && <span className="text-sm text-gray-600">{email}</span>}
        <Button variant="secondary" onClick={logout} className="text-sm">
          Sign out
        </Button>
      </div>
    </nav>
  )
}
