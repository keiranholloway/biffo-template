import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type CoreManifest, isTemplateOwned } from './core-manifest.js'

/**
 * Ownership guard for the portal (issue #279, part 1).
 *
 * `apps/` is user-owned, but the core admin UI inside it is not. That portal
 * code is a client of the Core API's admin surface — the `*-api.ts` modules call
 * `/api/v1/admin/*` — so it tracks the core API's version, not the instance's
 * product. While it was user-owned, template bugs in Biffo's own admin UI could
 * not be distributed: #275 and #276 both had to be hand-copied into every
 * instance.
 *
 * The split is deliberate and easy to get wrong in either direction, so it is
 * asserted here rather than left to whoever next edits the manifest:
 *   - too narrow, and portal fixes stop reaching instances again
 *   - too broad, and `core upgrade` starts proposing to overwrite the
 *     instance's own landing page and app config
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const manifest: CoreManifest = JSON.parse(
  readFileSync(resolve(repoRoot, 'core-manifest.json'), 'utf8'),
)

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
  ])('template-owned: %s', (path) => {
    expect(isTemplateOwned(path, manifest)).toBe(true)
  })

  it.each([
    // The instance's public front door — their branding, their copy.
    'apps/portal/src/app/page.tsx',
    // App-level config an instance legitimately tunes.
    'apps/portal/next.config.ts',
    'apps/portal/package.json',
    'apps/portal/tailwind.config.ts',
    // Any product UI the instance adds.
    'apps/my-product/src/index.tsx',
  ])('user-owned: %s', (path) => {
    expect(isTemplateOwned(path, manifest)).toBe(false)
  })

  it('keeps apps/ itself user-owned, so a new app defaults to the instance', () => {
    expect(manifest.userOwned).toContain('apps/')
  })
})
