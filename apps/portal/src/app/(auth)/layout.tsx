import type { ReactNode } from 'react'
import { PORTAL_LOGO_URL, PORTAL_TITLE } from '@/lib/branding'

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-surface-variant flex min-h-screen flex-col items-center justify-center">
      {/*
       * Instance logo/wordmark override (issue #1965), mirroring
       * NEXT_PUBLIC_PORTAL_PRIMARY_COLOR's mechanism (#1945): `PORTAL_LOGO_URL`
       * (`@/lib/branding`) is unset for an un-branded instance, so this renders
       * nothing here rather than a broken image — the current text-only
       * sign-in/set-new-password/forgot-password header (`login/page.tsx`) is
       * unchanged in that case. A plain `<img>` rather than `next/image`: the
       * URL points at a host the template cannot know in advance (an
       * instance's own asset bucket/CDN), and `next/image` requires that host
       * to be allowlisted via `next.config.ts`'s `images.remotePatterns` at
       * build time, which defeats a per-instance runtime-configured value.
       */}
      {PORTAL_LOGO_URL && (
        <img src={PORTAL_LOGO_URL} alt={PORTAL_TITLE} className="mb-6 h-12 w-auto" />
      )}
      {children}
    </div>
  )
}
