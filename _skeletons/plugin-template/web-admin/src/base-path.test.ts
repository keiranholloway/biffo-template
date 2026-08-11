import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The Vite `base` must name THIS plugin, and the built HTML's asset
 * references must actually live under it.
 *
 * Ported from idea-scout's guard (biffo-template#1492), which exists because
 * idea-scout's own vite.config.ts was pasted from ideation's and kept
 * ideation's base — 503, blank page, and every other local gate (eslint, tsc,
 * unit tests, `vite build` itself) passed, because `base` only affects the
 * URLs inside the emitted HTML. It was found by loading the deployed page and
 * reading the network log — not a check that runs on every PR. This is that
 * check, generalised so a plugin scaffolded from this skeleton inherits it
 * automatically rather than every plugin author re-discovering the bug.
 *
 * Reads the plugin name OUT of vite.config.ts itself rather than hardcoding
 * it, so this file needs no token substitution at scaffold time and stays
 * correct whatever `biffo plugin create` rewrites `base` to.
 */
const ROOT = join(__dirname, '..')

function pluginFromConfig(config: string): string {
  const match = config.match(/base:\s*'\/api\/v1\/plugins\/([^/]+)\/admin\/'/)
  expect(match, "no `base: '/api/v1/plugins/<name>/admin/'` found in vite.config.ts").not.toBeNull()
  return match![1]
}

describe('vite base path', () => {
  const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
  const plugin = pluginFromConfig(config)

  it('is the full API Gateway path for THIS plugin', () => {
    expect(config).toContain(`base: '/api/v1/plugins/${plugin}/admin/'`)
  })

  // There is deliberately NO "the config mentions no other plugin" test. That
  // shape (ban a token) rejects the correct fix as readily as the bug: a
  // comment legitimately naming a DIFFERENT plugin, to explain this exact
  // trap, is exactly what this file's own header does. Assert the property,
  // not the absence of a string.

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
      expect(ref.startsWith(`/api/v1/plugins/${plugin}/admin/`), `bad asset path: ${ref}`).toBe(
        true,
      )
    }
  })
})
