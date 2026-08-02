'use client'

import { NoAccess } from '@/components/no-access'

export default function NoAccessPage() {
  return (
    <NoAccess
      title="No access"
      message="Your account doesn't have access to any applications. Contact your administrator to request access."
    />
  )
}
