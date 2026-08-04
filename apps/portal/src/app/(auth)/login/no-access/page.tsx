'use client'

import { NoAccess } from '@/components/no-access'

export default function NoAccessPage() {
  return (
    <NoAccess
      title="No access"
      message="Your account doesn't have access to any applications."
      // This route IS `resolveDestination`'s `noAccess` outcome, so there is no
      // surface to offer — /login/ would forward them straight back here
      // (#1310). Sign-out is the only honest way on from this page.
      recovery="none"
    />
  )
}
