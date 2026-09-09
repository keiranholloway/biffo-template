import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The Vite `base` must name THIS plugin, and the built HTML's asset
 * references must actually live under it.
 *
 * Ported from web-admin/src/base-path.test.ts, itself ported from
 * idea-scout's guard (biffo-template#1492): a vite.config.ts pasted from a
 * sibling and left pointing at the sibling's base — 503, blank page, and
 * every other local gate (eslint, tsc, unit tests, `vite build` itself)
 * passed, because `base` only affects the URLs inside the emitted HTML. This
 * copy exists because `user_frontend` (`/ui/`) is a separate mount from
 * `admin_ingress` (`/admin/`) with its own base string to get wrong.
 *
 * The expected plugin name comes from `biffo.plugin.json`'s own `name`
 * field — an independent ground truth scaffolded alongside vite.config.ts —
 * NOT from parsing it back out of the config under test. An earlier version
 * of this file did the latter and was proven tautological
 * (biffo-template#2024): it regex-extracted the "expected" name from the same
 * base string it then checked, so a base that was internally self-consistent
 * but named the WRONG plugin — exactly the idea-scout#1492
 * paste-from-a-sibling shape — still passed every assertion. `biffo.plugin.json`'s
 * `name` is set once, at scaffold time, by `biffo plugin create`'s token
 * substitution — the same operation that rewrites vite.config.ts's own
 * `example-plugin` token — so it cannot be derived from a wrong
 * vite.config.ts and cannot be fooled by a bad paste from it.
 */
const ROOT = join(__dirname, '..')

function expectedPluginName(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, '..', 'biffo.plugin.json'), 'utf8')) as {
    name?: string
  }
  expect(manifest.name, 'biffo.plugin.json has no top-level `name`').toBeTruthy()
  return manifest.name!
}

describe('vite base path', () => {
  const plugin = expectedPluginName()
  const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')

  it('is the full API Gateway path for THIS plugin', () => {
    expect(config).toContain(`base: '/api/v1/plugins/${plugin}/ui/'`)
  })

  // Deliberately no "the config mentions no other plugin" test — see
  // web-admin/src/base-path.test.ts's own comment on why that shape is wrong.

  it('the built index.html requests assets under that base', () => {
    // Skipped when dist/ is absent (a source checkout, not a built one). CI
    // runs `build` before `test` — but if it ever does not, this must not
    // pass silently, so the skip is explicit and visible.
    let html: string
    try {
      html = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8')
    } catch {
      console.warn('dist/index.html absent — build not run; base-path check skipped')
      return
    }
    const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    const assetRefs = srcs.filter((s) => s.includes('/assets/'))
    expect(assetRefs.length, 'no asset references in the built HTML').toBeGreaterThan(0)
    for (const ref of assetRefs) {
      expect(ref.startsWith(`/api/v1/plugins/${plugin}/ui/`), `bad asset path: ${ref}`).toBe(true)
    }
  })
})
