import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { NextConfig } from 'next'

/**
 * `src/instance-nav.ts` is OPTIONAL, and this is what makes it optional.
 *
 * ADR-0028 gave instances a user-owned place to declare admin nav entries, and
 * template-owned `nav.tsx` imports `@/instance-nav` statically. A bundler
 * resolves static imports at build time and cannot degrade, so as originally
 * shipped every instance had to carry a file whose whole content was an empty
 * array — and any instance created before ADR-0028 would fail `module not
 * found` on its next `core upgrade`, because `core upgrade` deliberately never
 * carries user-owned paths. Both live instances were in exactly that state.
 *
 * So: `tsconfig.json` points `@/instance-nav` at the template-owned empty
 * default, which always exists, and this alias overrides it with the
 * instance's own file when there is one. An instance that wants nav entries
 * creates `src/instance-nav.ts`; one that does not never learns this exists.
 *
 * Why the alias rather than a tsconfig fallback list: Next's SWC loader rejects
 * a multi-element `paths` array for a non-wildcard key outright —
 * *"should be an array with one element because the src path does not contain
 * a wildcard"* — so the obvious `["./src/instance-nav.ts", "./src/lib/…"]`
 * does not build. Verified, not assumed.
 *
 * The two must agree on the module's SHAPE, which they do by construction:
 * both export `INSTANCE_NAV_LINKS: InstanceNavLink[]` from the template-owned
 * contract, so typechecking against the default is sound for either.
 */
/**
 * Each optional instance-owned module, as `[instance file, template default]`.
 *
 * Two seams share this mechanism now (#1098 added the second), so the pair is
 * data rather than two hand-written aliases -- a third would otherwise be a
 * third place to forget one half.
 */
const instanceSeams: [string, string][] = [
  [
    join(import.meta.dirname, 'src', 'instance-nav.ts'),
    join(import.meta.dirname, 'src', 'lib', 'instance-nav-empty.ts'),
  ],
  [
    join(import.meta.dirname, 'src', 'instance-login-destinations.ts'),
    join(import.meta.dirname, 'src', 'lib', 'login-destinations-default.ts'),
  ],
]

/** The sliver of webpack's config this touches. Next types the callback's
 *  argument as `any`, which the shared lint config rightly refuses. */
interface WebpackResolveConfig {
  resolve: { alias?: Record<string, string> }
}

const nextConfig: NextConfig = {
  webpack: (config: WebpackResolveConfig) => {
    for (const [instanceFile, templateDefault] of instanceSeams) {
      if (!existsSync(instanceFile)) continue
      // Alias the RESOLVED path, not the '@/instance-*' specifier: SWC
      // rewrites tsconfig `paths` at transform time, so webpack never sees the
      // alias key. Verified — aliasing the specifier built successfully and
      // silently emitted the empty default.
      config.resolve.alias = { ...config.resolve.alias, [templateDefault]: instanceFile }
    }
    return config
  },
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
