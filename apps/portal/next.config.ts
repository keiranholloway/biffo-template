import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  // The portal is strictly the admin console (issue #306). It serves /admin and
  // /login; the root path belongs to the user-application sibling.
  //
  // Without this, the portal's assets serve from /_next/* — and a root sibling
  // has an empty basePath, so ITS assets would claim exactly the same prefix.
  // Two S3 origins, one URL path, and CloudFront cannot disambiguate: whichever
  // origin the behaviour points at answers the other app's chunk requests,
  // yielding 404s or a stale mismatched bundle.
  //
  // `assetPrefix` moves only the asset URLs, to /admin/_next/*, which the CDN
  // already routes to the portal via its `admin/*` behaviour. Deliberately NOT
  // `basePath: '/admin'`: with a basePath, routes are authored WITHOUT it, so
  // src/app/admin/plugins/page.tsx would serve at /admin/admin/plugins. Every
  // admin route would have to move up a directory and every internal href would
  // change — including the ones just corrected for trailing slashes in #275.
  //
  // NOTE: assetPrefix rewrites URLs only; the export still emits the files at
  // out/_next/*. The deploy workflow is what puts them at the S3 key
  // admin/_next/* so those URLs resolve. The two must move together — see
  // .github/workflows/deploy-app.yml.
  assetPrefix: '/admin',
  images: {
    unoptimized: true,
  },
}

export default nextConfig
