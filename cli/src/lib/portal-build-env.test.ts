/**
 * Every `NEXT_PUBLIC_*` the portal reads must be forwarded by every "Build
 * portal" step, or be deliberately allowlisted.
 *
 * The portal builds with `output: 'export'`, so a `NEXT_PUBLIC_*` value is
 * baked into the static bundle at build time or it does not exist at runtime at
 * all — there is no server to read it later, and no error when it is missing:
 * the code takes its `|| default` branch and the instance sees the template's
 * default forever.
 *
 * That is #964. `apps/portal/src/lib/branding.ts` has read
 * `NEXT_PUBLIC_PORTAL_TITLE` since #389 under a documented promise — "an
 * instance sets the GitHub var and its deploy build picks it up, with zero
 * divergence from the template" — and `deploy-app.yml` never forwarded it, in
 * any of its three build jobs. The promise was false from the day it was
 * written: every instance that set `PORTAL_TITLE` got `Biffo Portal` anyway,
 * with nothing anywhere reporting a problem.
 *
 * A grep would have caught it in a second, and nobody ran one, because there
 * was no reason to suspect it. That is what makes it worth a guard rather than
 * care: the reader of `branding.ts` cannot see the workflow, the reader of the
 * workflow cannot see `branding.ts`, and the failure is silent in both. Same
 * "code↔infra gap CI cannot catch" class as `workflow-variable-contract.test.ts`
 * — and, as there, **this repo never runs `deploy-app.yml`**, so an instance is
 * the first place the gap can possibly show.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(join(repoRoot, '.github/workflows/deploy-app.yml'), 'utf8')

/**
 * Read by the portal but deliberately NOT forwarded. Every entry needs a reason
 * that survives being read out loud; "it has a default" is not one on its own,
 * because `PORTAL_TITLE` had a default too and that is exactly how #964 hid.
 */
const NOT_FORWARDED = new Map([
  [
    'NEXT_PUBLIC_REGISTRY_URL',
    // A developer-time override for pointing the plugin store at a non-public
    // registry. Its default is the registry every instance is meant to use, so
    // there is no per-instance value to forward and no repo variable to read.
    'dev override; the default is the value every instance wants',
  ],
])

/** Recursively collect .ts/.tsx sources, excluding tests. */
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return []
    return [path]
  })

/** `process.env.NEXT_PUBLIC_X` and `process.env['NEXT_PUBLIC_X']` alike. */
const readByPortal = (): Set<string> => {
  const found = new Set<string>()
  for (const file of sources(join(repoRoot, 'apps/portal/src'))) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/process\.env(?:\.|\[')(NEXT_PUBLIC_[A-Z0-9_]+)/g))
      found.add(m[1])
  }
  return found
}

/** The `env:` block of each `- name: Build portal` step, one per build job. */
const buildPortalEnvBlocks = (yaml: string): string[] => {
  const lines = yaml.split('\n')
  const blocks: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^ {6}- name: Build portal$/.test(lines[i])) continue
    const block: string[] = []
    // Consume to the end of the step: the next line at the step's own indent.
    for (let j = i + 1; j < lines.length && !/^ {6}\S/.test(lines[j]); j++) block.push(lines[j])
    blocks.push(block.join('\n'))
  }
  return blocks
}

describe('deploy-app.yml forwards the portal build-time environment', () => {
  const required = [...readByPortal()].filter((v) => !NOT_FORWARDED.has(v)).sort()
  const blocks = buildPortalEnvBlocks(workflow)

  it('found the portal vars and the build steps, so an empty scan cannot pass', () => {
    // dev, staging, prod.
    expect(blocks).toHaveLength(3)
    // The one #964 is about, named explicitly: if branding.ts is ever
    // refactored out from under this scanner, this line fails rather than the
    // guard quietly asserting nothing.
    expect(readByPortal()).toContain('NEXT_PUBLIC_PORTAL_TITLE')
    expect(required.length).toBeGreaterThan(1)
  })

  it.each(required)('%s is forwarded by all three Build portal steps', (name) => {
    for (const block of blocks) {
      expect(block).toMatch(new RegExp(`^\\s+${name}: `, 'm'))
    }
  })

  it('reads PORTAL_TITLE from a repository variable, not a hardcoded value', () => {
    // The fallback belongs in branding.ts (`|| 'Biffo Portal'`), not here — a
    // default baked into the workflow would override an instance's own var.
    const matches = [...workflow.matchAll(/NEXT_PUBLIC_PORTAL_TITLE: (.+)/g)].map((m) =>
      m[1].trim(),
    )
    expect(matches).toEqual(Array(3).fill('${{ vars.PORTAL_TITLE }}'))
  })

  it('detects a build step that drops a variable (negative control)', () => {
    const gutted = workflow.replace(/^ +NEXT_PUBLIC_PORTAL_TITLE: .+$/m, '')
    const stillForwarded = buildPortalEnvBlocks(gutted).filter((b) =>
      /^\s+NEXT_PUBLIC_PORTAL_TITLE: /m.test(b),
    )
    expect(stillForwarded).toHaveLength(2)
  })

  it('keeps every allowlisted exemption justified', () => {
    for (const [name, reason] of NOT_FORWARDED) {
      expect(readByPortal(), `${name} is allowlisted but nothing reads it`).toContain(name)
      expect(reason.length).toBeGreaterThan(20)
    }
  })
})
