'use client'

import Link from 'next/link'

export default function NoAccessPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm rounded-xl border border-dashed border-gray-300 bg-white p-8">
        <h1 className="text-lg font-semibold text-gray-900">No access</h1>
        <p className="mt-2 text-sm text-gray-600">
          Your account doesn&apos;t have access to any applications. Contact your administrator to
          request access.
        </p>
        <Link
          href="/login/"
          className="mt-4 inline-block text-sm font-medium text-blue-600 hover:underline"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
