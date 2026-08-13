import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findSkeletonRoot } from './plugin-scaffold.js'
import { validateManifest } from './plugin-manifest.js'

/**
 * The real `_skeletons/plugin-template/biffo.plugin.json` must pass the same
 * validation `biffo plugin install`/`upgrade` run against every plugin —
 * nothing else proves the reference example a new plugin author copies is
 * actually well-formed. No prior test read this file at all (checked before
 * adding biffo-template#1554's `seed` block here): every other skeleton test
 * either validates a synthetic fixture manifest or scaffolds the skeleton
 * without validating its manifest's *content*.
 */
function realSkeletonManifestPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const skeleton = findSkeletonRoot(here, 'plugin-template')
  if (!skeleton) throw new Error('could not locate _skeletons/plugin-template from ' + here)
  return join(skeleton, 'biffo.plugin.json')
}

describe("the plugin-template skeleton's own biffo.plugin.json", () => {
  it('validates cleanly against validateManifest', () => {
    const raw = JSON.parse(readFileSync(realSkeletonManifestPath(), 'utf8'))
    expect(() => validateManifest(raw)).not.toThrow()
  })

  it('declares a seed whose baseline_tables are its own declared tables (biffo-template#1554)', () => {
    const raw = JSON.parse(readFileSync(realSkeletonManifestPath(), 'utf8'))
    const manifest = validateManifest(raw)
    expect(manifest.seed?.dir).toBe('db/seed')
    expect(manifest.seed?.baseline_tables).toEqual(['example_widgets'])
  })
})
