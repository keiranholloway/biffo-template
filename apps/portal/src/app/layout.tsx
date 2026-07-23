import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { AuthProvider } from '@/context/auth-context'
import { PORTAL_TITLE } from '@/lib/branding'
import './globals.css'

export const metadata: Metadata = {
  title: PORTAL_TITLE,
  description: 'Biffo base portal',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  )
}
