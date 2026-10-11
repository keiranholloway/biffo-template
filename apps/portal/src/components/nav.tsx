'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import type { ReactNode } from 'react'
import { useAuth } from '@/context/auth-context'
import { INSTANCE_NAV_LINKS } from '@/instance-nav'
import { createApiClient } from '@/lib/api-client'
import { PORTAL_TITLE } from '@/lib/branding'
import { sessionGroups } from '@/lib/cognito-groups'
import { resolveInstanceNavLinks } from '@/lib/instance-nav-contract'
import { fetchInstalledPlugins } from '@/lib/plugin-api'
import {
  PLUGIN_PANEL_PATH,
  type PluginNavLink,
  resolvePluginNavLinks,
} from '@/lib/plugin-nav-contract'
import { Button } from '@biffo/ui'

const CORE_LINKS = [
  { href: '/admin/microservices/', label: 'Microservices' },
  { href: '/admin/marketplace/', label: 'Marketplace' },
  { href: '/admin/plugins/', label: 'Plugins' },
  { href: '/admin/endpoints/', label: 'Endpoints' },
  { href: '/admin/users/', label: 'Users' },
  { href: '/admin/orchestration/', label: 'Workflows' },
  { href: '/admin/agent-runs/', label: 'Agent runs' },
  { href: '/admin/prompt-components/', label: 'Prompt library' },
]

function stripSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

/** True when `pathname` is the link's page or one of its detail pages. */
export function isCurrentPath(href: string, pathname: string | null): boolean {
  if (pathname == null) return false
  const target = stripSlash(href.split(/[?#]/)[0] ?? href)
  const here = stripSlash(pathname)
  return here === target || here.startsWith(`${target}/`)
}

/**
 * Plugin panel links share one path and differ by `?name=`, so path matching
 * alone would mark every plugin current at once.
 */
function isCurrentPanel(href: string, pathname: string | null, search: string | null): boolean {
  if (!isCurrentPath(PLUGIN_PANEL_PATH, pathname)) return false
  const want = new URL(href, 'http://x').searchParams.get('name')
  return want != null && want === search
}

function NavLink({
  href,
  pathname,
  panelName,
  children,
}: {
  href: string
  pathname: string | null
  /** For plugin panel links: the `name` currently shown, if any. */
  panelName?: string | null
  children: ReactNode
}) {
  const isPanel = href.startsWith(PLUGIN_PANEL_PATH)
  const current = isPanel
    ? isCurrentPanel(href, pathname, panelName ?? null)
    : isCurrentPath(href, pathname)
  const className = `whitespace-nowrap text-sm ${
    current
      ? 'font-semibold text-gray-900 underline underline-offset-4'
      : 'text-gray-600 hover:text-gray-900'
  }`
  const ariaCurrent = current ? 'page' : undefined
  return (
    <Link href={href} className={className} aria-current={ariaCurrent}>
      {children}
    </Link>
  )
}

export function Nav() {
  const pathname = usePathname()
  const panelName = useSearchParams().get('name') ?? null
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
    <nav className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b px-6 py-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
        <Link href="/admin/" className="text-lg font-semibold">
          {PORTAL_TITLE}
        </Link>
        {CORE_LINKS.map((link) => (
          <NavLink key={link.href} href={link.href} pathname={pathname}>
            {link.label}
          </NavLink>
        ))}
        {/*
         * An instance's OWN admin surfaces (ADR-0028). Declared in the
         * user-owned `@/instance-nav`, rendered after the core links, so
         * adding one never requires patching this template-owned file. The
         * base template declares none, so this renders nothing.
         */}
        {resolveInstanceNavLinks(INSTANCE_NAV_LINKS).map((link) => (
          <NavLink key={link.href} href={link.href} pathname={pathname}>
            {link.label}
          </NavLink>
        ))}
        {/*
         * Installed plugins' declared admin surfaces (issue #1555). Renders
         * after the instance's own links. Each links to the portal's
         * plugin-panel route, which frames the plugin's admin surface so the
         * nav and account controls stay visible (biffo-template#2495).
         */}
        {pluginLinks.map((link) => (
          <NavLink key={link.href} href={link.href} pathname={pathname} panelName={panelName}>
            {link.label}
          </NavLink>
        ))}
      </div>
      <div className="flex min-w-0 max-w-full items-center gap-4">
        {email != null && <span className="truncate text-sm text-gray-600">{email}</span>}
        <Button variant="secondary" onClick={logout} className="shrink-0 whitespace-nowrap text-sm">
          Sign out
        </Button>
      </div>
    </nav>
  )
}
