import type { NextConfig } from 'next'

// basePath must match the "<name>" segment CloudFront routes on
// (baseurl.com/<name>/*, see infra/main.tf's sibling registration) — the
// parent's CDN forwards the full request URI (e.g. /<name>/foo.html)
// straight to this sibling's S3 origin with no prefix stripping, so the
// static export's own asset/link URLs must already include that prefix.
// Set at build time; see .github/workflows/ci.yml / deploy.yml.
const basePath = process.env['NEXT_PUBLIC_BASE_PATH'] ?? ''

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  basePath,
  images: {
    unoptimized: true,
  },
}

export default nextConfig
