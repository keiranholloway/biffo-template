import type { CSSProperties, ReactNode } from 'react'
import type { Metadata } from 'next'
import { AuthProvider } from '@/context/auth-context'
import { PORTAL_TITLE } from '@/lib/branding'
import './globals.css'

export const metadata: Metadata = {
  title: PORTAL_TITLE,
  description: 'Biffo base portal',
}

/**
 * Instance brand override (issue #1945), read the same way `PORTAL_TITLE` is
 * (`@/lib/branding`): a build-time `NEXT_PUBLIC_*` env var, forwarded into the
 * "Build portal" step of every job in `.github/workflows/deploy-app.yml`. The
 * portal builds with `output: 'export'`, so this is baked into the static
 * bundle at build time — an instance sets the `PORTAL_PRIMARY_COLOR`
 * repository variable and its next deploy picks it up, with zero divergence
 * from the template.
 *
 * Unset (`''`/`undefined`) is the normal case, and deliberately produces no
 * inline style at all rather than an empty `style="--primary: "` — the CSS
 * default in `globals.css` already renders the unbranded template look, so an
 * un-branded instance (this repo's own `biffo-platform` included) is
 * unchanged.
 */
const PORTAL_PRIMARY_COLOR = process.env.NEXT_PUBLIC_PORTAL_PRIMARY_COLOR || undefined

/**
 * Turns an (optional) override value into the `<html>` inline style that
 * carries it — a plain function so the override logic is testable without
 * rendering a full `<html>`/`<body>` document. An inline style on `<html>`
 * beats a second stylesheet: it wins the cascade over the `:root` default in
 * `globals.css` by specificity alone, without needing `!important` or a
 * build-time template edit.
 */
export function resolvePortalThemeStyle(
  primaryColor: string | undefined,
): CSSProperties | undefined {
  return primaryColor ? ({ '--primary': primaryColor } as CSSProperties) : undefined
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" style={resolvePortalThemeStyle(PORTAL_PRIMARY_COLOR)}>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  )
}
