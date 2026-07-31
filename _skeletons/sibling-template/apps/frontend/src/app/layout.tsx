import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { SIBLING_TITLE } from '@/lib/branding'
import './globals.css'

export const metadata: Metadata = {
  // Derived from this sibling's own name at build time — see lib/branding.ts.
  // `title.template` composes per-page titles for free: a page exporting
  // `metadata = { title: 'Weekly' }` then renders "<Sibling> - Weekly".
  title: {
    default: SIBLING_TITLE,
    template: `${SIBLING_TITLE} - %s`,
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
