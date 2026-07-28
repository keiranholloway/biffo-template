/** Guards for the token definition itself.
 *
 * These values are consumed by apps that deploy independently and are not
 * rebuilt when this file changes, so a mistake here does not surface as a
 * failing build somewhere — it surfaces as a plugin quietly rendering with a
 * missing colour weeks later. The checks below are cheap and catch the classes
 * of mistake that would do that.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const CSS = readFileSync(join(process.cwd(), 'tokens.css'), 'utf8')
const BODY = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

function declarations(): { name: string; value: string }[] {
  return [...BODY.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((match) => ({
    name: match[1],
    value: match[2].trim(),
  }))
}

/** The published surface.
 *
 * Listed explicitly because **removing or renaming a token is a breaking change
 * for consumers this repo cannot see** — a separately-deployed plugin keeps
 * referencing `var(--brand)` and simply renders without it. Adding a token
 * fails this list too, which is the point: the addition should be a deliberate,
 * reviewed line in the diff rather than a silent widening of the contract.
 */
const PUBLISHED = [
  '--accent',
  '--bg',
  '--bg-subtle',
  '--border',
  '--border-strong',
  '--brand',
  '--brand-soft',
  '--brand-strong',
  '--container',
  '--ink',
  '--ink-2',
  '--nav-h',
  '--radius',
  '--radius-lg',
  '--shadow-lg',
  '--shadow-md',
  '--shadow-sm',
  '--state-caution',
  '--state-caution-soft',
  '--state-negative',
  '--state-negative-soft',
  '--state-positive',
  '--state-positive-soft',
  '--surface',
  '--text',
  '--text-invert',
  '--text-invert-muted',
  '--text-muted',
]

describe('design tokens', () => {
  it('publishes exactly the documented set', () => {
    expect(
      declarations()
        .map((d) => d.name)
        .sort(),
    ).toEqual([...PUBLISHED].sort())
  })

  it('declares every token exactly once', () => {
    const names = declarations().map((d) => d.name)
    const duplicated = [...new Set(names.filter((n) => names.filter((m) => m === n).length > 1))]

    expect(duplicated).toEqual([])
  })

  it('gives every token a non-empty value', () => {
    expect(
      declarations()
        .filter((d) => d.value === '')
        .map((d) => d.name),
    ).toEqual([])
  })

  it('defines them in a single :root block, so one import is enough', () => {
    // A consumer imports this file once. Two blocks would mean cascade order
    // decides the value, which is not something a downstream app can reason
    // about from an npm dependency.
    expect(BODY.match(/:root\s*\{/g) ?? []).toHaveLength(1)
  })

  it('is shipped by the package', () => {
    // `files` decides what npm actually publishes. Omitting tokens.css would
    // produce a package that installs cleanly and exports nothing — the same
    // silent-empty failure shape as the stylesheet that styled no classes.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      files: string[]
      exports: Record<string, string>
      private?: boolean
    }

    expect(pkg.files).toContain('tokens.css')
    expect(pkg.exports['./tokens.css']).toBe('./tokens.css')
    // The other workspace packages are `private: true` and never publish. This
    // one has to, or no separately-deployed app can consume it.
    expect(pkg.private).toBeUndefined()
  })
})
