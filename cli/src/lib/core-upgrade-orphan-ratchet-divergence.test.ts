import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import {
  checkCoreOwnership,
  DIVERGENCE_FILE,
  readDivergenceConfig,
} from './core-ownership-guard.js'
import { checkOrphanRatchet, type MergeFileFn, planCoreUpgrade } from './core-upgrade.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * Fix for #1602 (class #1362, "a guard resolves its answer from a different
 * document than the actor it is guarding"): a template-owned path added under
 * an ACCEPTED `Core-Divergence` — declared, long-term, in `biffo.divergence.json`
 * — still incremented the #1026 orphan count at the next `biffo core upgrade`.
 *
 * ## The two documents, before this fix
 *
 * - `checkCoreOwnership` (commit-time, in `core-ownership-guard.ts`) reads
 *   `biffo.divergence.json`'s `warnOnly` prefixes and accepts a matching path
 *   without even needing a trailer — that IS the mechanism for "this instance
 *   knowingly differs here, and here is why, permanently".
 * - `classify()`'s `!inBase && !inTheirs` branch (upgrade-time, in
 *   `core-upgrade.ts`) never consulted that file at all. It marked EVERY such
 *   path `orphaned: true` unconditionally, so `checkOrphanRatchet` counted a
 *   declared, accepted divergence as unsanctioned drift.
 *
 * `isDeclaredDivergent` already existed in this exact file (built for the
 * sibling "instance deleted a template file" branch, #395) and reads exactly
 * `biffo.divergence.json` — the fix is `classify()`'s add-side branch
 * consulting the same closure the delete-side branch already does, so the
 * ratchet derives its answer from the one place the divergence is recorded
 * rather than requiring a second, separately-maintained declaration.
 *
 * This is deliberately a SEPARATE test file from
 * `core-ownership-orphan-disagreement.test.ts`, which pins a different,
 * still-open disagreement (class #1362 instance #8: an UNDECLARED orphan that
 * the guard blocks outright and `classify()` merely flags) and is explicitly
 * recorded as unresolved in `guard-authority-inventory.ts`. Conflating the two
 * would either weaken instance 8's honest "still open" statement or make this
 * fix look like it also settles a question it does not touch.
 */

const MANIFEST: CoreManifest = {
  version: 1,
  templateOwned: ['.github/workflows/'],
  userOwned: [],
}

const neverMerges: MergeFileFn = async () => {
  throw new Error('classify() reached the merge step for a path with no base and no theirs')
}

function w(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

describe('checkOrphanRatchet vs checkCoreOwnership on a declared Core-Divergence (#1602)', () => {
  let base: string
  let ours: string
  let theirs: string

  beforeEach(() => {
    base = makeTmpDir('base')
    ours = makeTmpDir('ours')
    theirs = makeTmpDir('theirs')
  })
  afterEach(() => {
    for (const d of [base, ours, theirs]) rmSync(d, { recursive: true, force: true })
  })

  // The real shape from the issue: a real-Postgres CI lane a template-owned
  // gate depends on finding at exactly this path (biffo-platform's actual
  // rls-tests.yml addition).
  const DIVERGED = '.github/workflows/rls-tests.yml'

  const DIVERGENCE_CONFIG = {
    note: 'Declared divergences this instance knowingly carries.',
    warnOnly: [
      {
        prefix: '.github/workflows/rls-tests.yml',
        reason: 'Real-Postgres RLS lane; the template gate matches this exact path and name.',
        upstream: '#1602',
      },
    ],
  }

  it('the commit-time guard accepts the file via the declared divergence, unblocked', () => {
    const config = DIVERGENCE_CONFIG
    const result = checkCoreOwnership({
      changedFiles: [DIVERGED],
      manifest: MANIFEST,
      isInstance: true,
      warnOnly: config.warnOnly,
    })

    expect(result.blocked).toEqual([])
    expect(result.warned.map((w) => w.path)).toEqual([DIVERGED])
  })

  it('the upgrade-time ratchet no longer counts that same declared file as orphaned', async () => {
    w(ours, DIVERGED, 'name: RLS Tests\n')
    w(ours, DIVERGENCE_FILE, JSON.stringify(DIVERGENCE_CONFIG, null, 2))

    const plan = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: neverMerges,
    })

    // The denominator (#1363): how many paths classify() actually examined,
    // printed rather than left implicit — a single-path fixture would let a
    // green assertion hide an unstated set of one.
    console.log(
      `core-upgrade-orphan-ratchet-divergence: ${plan.entries.length} path(s) examined by ` +
        `classify(), 1 declared-divergent path under test (${DIVERGED})`,
    )
    expect(plan.entries.length).toBeGreaterThan(0)

    const entry = plan.entries.find((e) => e.path === DIVERGED)
    expect(entry, 'the upgrade should have an opinion about this path').toBeDefined()
    expect(entry?.status).toBe('keep-ours')

    // This is the line #1602 is about: it fails against the unfixed code
    // (orphaned === true) and passes once classify() consults
    // isDeclaredDivergent() on this branch too.
    expect(entry?.orphaned).not.toBe(true)

    expect(plan.orphaned.map((e) => e.path)).not.toContain(DIVERGED)

    const ratchet = checkOrphanRatchet(plan.orphaned.length, { count: 0 })
    expect(ratchet.increased).toBe(false)
  })

  it('an UNDECLARED file under the same prefix is still counted — this is not "stop counting orphans"', async () => {
    const UNDECLARED = '.github/workflows/some-other-lane.yml'
    w(ours, UNDECLARED, 'name: Some Other Lane\n')
    // No biffo.divergence.json at all in `ours` this time.
    expect(readDivergenceConfig(ours).warnOnly).toEqual([])

    const plan = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: neverMerges,
    })

    const entry = plan.entries.find((e) => e.path === UNDECLARED)
    expect(entry?.orphaned).toBe(true)
    expect(plan.orphaned.map((e) => e.path)).toContain(UNDECLARED)

    const ratchet = checkOrphanRatchet(plan.orphaned.length, { count: 0 })
    expect(ratchet.increased).toBe(true)
  })
})
