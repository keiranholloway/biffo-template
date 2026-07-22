import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type CoreManifest, isTemplateOwned } from './core-manifest.js'
import { isInstanceRepo } from './core-version.js'

/**
 * Ownership guard for the portal (issue #279 part 1, corrected by #306).
 *
 * `apps/` is user-owned; `apps/portal/` inside it is not. The portal is
 * strictly the admin console — it serves `/admin` and `/login`, the root path
 * belongs to the user's application sibling, and nothing user-owned lives in
 * it. It is a client of the Core API's admin surface (the `*-api.ts` modules
 * call `/api/v1/admin/*`), so it tracks the core API's version, not the
 * instance's product. While it was user-owned, template bugs in Biffo's own
 * admin UI could not be distributed: #275 and #276 both had to be hand-copied
 * into every instance.
 *
 * #279 first drew this line path-by-path (`app/admin/`, `app/(auth)/`,
 * `components/`, `lib/`, `context/`), which left `apps/portal/src/app/page.tsx`
 * and `next.config.ts` user-owned. That was a trap: `components/`, `lib/` and
 * `context/` are exactly where a user would put `ProductCard.tsx` or
 * `stripe.ts`, and `core upgrade` would then propose deleting them. #306 makes
 * the assumption explicit instead of documenting around it, so the carve-out
 * collapses to one prefix.
 *
 * The boundary is easy to get wrong in either direction, so it is asserted here
 * rather than left to whoever next edits the manifest:
 *   - too narrow, and portal fixes stop reaching instances again
 *   - too broad, and `core upgrade` starts proposing to overwrite an app the
 *     instance owns
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const manifest: CoreManifest = JSON.parse(
  readFileSync(resolve(repoRoot, 'core-manifest.json'), 'utf8'),
)
const runningInInstance = isInstanceRepo(repoRoot)

describe('portal ownership split', () => {
  it.each([
    'apps/portal/src/app/admin/page.tsx',
    'apps/portal/src/app/admin/plugins/[slug]/page.tsx',
    'apps/portal/src/app/(auth)/login/page.tsx',
    'apps/portal/src/lib/plugin-api.ts',
    'apps/portal/src/lib/return-to.ts',
    'apps/portal/src/components/nav.tsx',
    'apps/portal/src/components/auth-guard.tsx',
    'apps/portal/src/context/auth-context.tsx',
    // Whole-portal ownership (#306): the app shell and its build config are the
    // template's too. `next.config.ts` in particular carries the
    // `assetPrefix: '/admin'` that keeps the portal's assets off `/_next/*`,
    // where the root sibling's would collide with them — an instance silently
    // reverting it would break both apps, so an upgrade must be able to restore
    // it.
    'apps/portal/next.config.ts',
    'apps/portal/package.json',
    'apps/portal/src/app/layout.tsx',
    'apps/portal/public/admin/siblings.json',
  ])('template-owned: %s', (path) => {
    expect(isTemplateOwned(path, manifest)).toBe(true)
  })

  it.each([
    // Any product UI the instance adds — a NEW app under apps/, not the portal.
    'apps/my-product/src/index.tsx',
    'apps/my-product/next.config.ts',
  ])('user-owned: %s', (path) => {
    expect(isTemplateOwned(path, manifest)).toBe(false)
  })

  it('keeps apps/ itself user-owned, so a new app defaults to the instance', () => {
    expect(manifest.userOwned).toContain('apps/')
  })

  it('owns apps/portal/ as a single prefix, not path-by-path', () => {
    // The #279 carve-out left components/, lib/ and context/ template-owned —
    // the natural home for user code, which `core upgrade` would then propose
    // deleting. Re-introducing sub-paths of the portal here would re-introduce
    // that trap.
    expect(manifest.templateOwned).toContain('apps/portal/')
    expect(
      manifest.templateOwned.filter((p) => p.startsWith('apps/portal/') && p !== 'apps/portal/'),
    ).toEqual([])
  })

  // The only assertion here about the repo's own FILES rather than the manifest,
  // so the only one an instance cannot satisfy (#367): an instance that predates
  // #306 still has its landing page at that path, and removing it is its own
  // migration, not something a template-shipped test should red on. Everything
  // above reads core-manifest.json, which is template-owned and therefore
  // identical in an instance — worth keeping live there, since it catches a
  // manifest an upgrade mangled.
  it.skipIf(runningInInstance)(
    'no longer ships a portal landing page — the root path is the sibling’s',
    () => {
      // The portal serves /admin and /login only (#306, decision 2). A page.tsx
      // at the app root would export an index.html that competes with the root
      // sibling for `/`.
      expect(existsSync(resolve(repoRoot, 'apps/portal/src/app/page.tsx'))).toBe(false)
    },
  )
})
