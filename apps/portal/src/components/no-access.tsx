'use client'

import Link from 'next/link'

/**
 * The one surface the portal shows a signed-in person it cannot serve.
 *
 * There were two ways to be refused and only one of them had a face: the
 * `/login/no-access/` route, reached when `resolveDestination` can find no
 * landing for an account. The other — asking for a page your groups do not
 * cover — had none at all, because nothing checked (#1104). Both now render
 * this, so "you are signed in, and this is not for you" looks the same
 * wherever it happens and is written once in the product's voice rather than
 * improvised per call site.
 *
 * The link is deliberately `/login/`, not a hardcoded app path. Someone
 * already signed in is forwarded from there to wherever their roles land them
 * (`resolveDestination`), and someone who needs a different account can sign
 * in. One destination serves both, and it is the only route this app can be
 * sure exists in every instance.
 */
export function NoAccess({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm rounded-xl border border-dashed border-gray-300 bg-white p-8">
        <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
        <p className="mt-2 text-sm text-gray-600">{message}</p>
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
