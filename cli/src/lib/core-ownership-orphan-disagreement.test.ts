import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import { checkCoreOwnership } from './core-ownership-guard.js'
import { type MergeFileFn, planCoreUpgrade } from './core-upgrade.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * The disagreement test for `core-ownership-guard`, instance #8 of class #1362
 * ("a guard resolves its answer from a different document than the actor it is
 * guarding"). Named as missing in `guard-authority-inventory.ts`, which records
 * this guard as `disagreementTest: null`.
 *
 * ## The two documents
 *
 * - **The guard** reads `core-manifest.json`'s `templateOwned` **prefix list**,
 *   via `isTemplateOwned()`. A path is template-owned if it starts with a listed
 *   prefix — a question about a string.
 * - **The actor** is `planCoreUpgrade`'s `classify()`, which decides what the
 *   upgrade actually *does* to that path. It reads the base/ours/theirs trees:
 *   a path present only in the instance is `keep-ours` + `orphaned`, because
 *   there is no upstream copy to merge against.
 *
 * For a file the template has never shipped, under a template-owned prefix,
 * those two answer differently — and the guard is the one that acts on a
 * document the upgrade does not use.
 *
 * ## Why this is a defect and not a pair of opinions
 *
 * The guard does not merely disagree; **it blocks a commit with an instruction
 * that cannot be followed.** Its refusal says the change belongs upstream in
 * `biffo-template`. The file does not exist upstream, so there is no change to
 * make there. The instance author is told to go and edit nothing, in a repo
 * where the path is absent, to unblock a file that `biffo core upgrade` would
 * have left alone anyway.
 *
 * That is exactly the shape #1362 exists to catch, and it is instance #8's own
 * report: *"it blocked a commit and told the author to make the change in a
 * repo where the file does not exist"*, followed the next day by *"second
 * occurrence — same day, different file. This is not a one-off mis-scoped
 * path."*
 *
 * ## What this test asserts, and why it is written as agreement
 *
 * It builds ONE state and asks BOTH sides. It does not re-implement either
 * side's rule: `planCoreUpgrade` is driven over real directories so the actor's
 * answer is the shipping one, and `checkCoreOwnership` is called with the same
 * manifest the upgrade was planned with. A test that recomputed "is this
 * orphaned?" from its own predicate would be agreeing with itself — the
 * `_in_step_snapshot` mistake recorded on `biffo-plugin-marketing#175`, where a
 * fixture built from the code under test could not fail with it.
 *
 * The inventory records that either of two outcomes closes this instance:
 * the guard agreeing with `classify()`, **or** the guard failing loudly and
 * naming its own gap. Until one ships, this test states the disagreement
 * precisely rather than asserting the behaviour anybody wants — see the final
 * case, which is the one that will change when the fix lands.
 */

const MANIFEST: CoreManifest = {
  version: 1,
  templateOwned: ['services/api/'],
  userOwned: ['services/'],
}

/** The upgrade's merge step is never reached for an orphan, so a merge that
 *  throws proves it: if `classify()` ever stopped short-circuiting, this would
 *  fail loudly instead of silently taking a merged result. */
const neverMerges: MergeFileFn = async () => {
  throw new Error('classify() reached the merge step for a path with no base and no theirs')
}

describe('core-ownership-guard vs the upgrade that acts (class #1362, instance #8)', () => {
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

  function w(root: string, rel: string, content: string): void {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }

  /** A path under a template-owned prefix that the template has never shipped:
   *  present in the instance, absent from base and from upstream. */
  const ORPHAN = 'services/api/instance_only_route.py'

  it('the actor leaves an instance-only file under a template-owned prefix alone', async () => {
    w(ours, ORPHAN, 'written in the instance, never shipped upstream')

    const plan = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: neverMerges,
    })

    const entry = plan.entries.find((e) => e.path === ORPHAN)
    expect(entry, 'the upgrade should have an opinion about this path').toBeDefined()
    expect(entry?.status).toBe('keep-ours')
    expect(entry?.orphaned).toBe(true)
  })

  it('the guard calls the same file template-owned and blocks it', () => {
    const result = checkCoreOwnership({
      changedFiles: [ORPHAN],
      manifest: MANIFEST,
      isInstance: true,
    })

    expect(result.skipped).toBeNull()
    expect(result.blocked).toEqual([ORPHAN])
  })

  it('DISAGREEMENT: the upgrade keeps it as the instance’s, the guard forbids editing it', async () => {
    w(ours, ORPHAN, 'written in the instance, never shipped upstream')

    const plan = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: neverMerges,
    })
    const actorTreatsAsInstanceOwned =
      plan.entries.find((e) => e.path === ORPHAN)?.orphaned === true

    const guardForbidsEditing = checkCoreOwnership({
      changedFiles: [ORPHAN],
      manifest: MANIFEST,
      isInstance: true,
    }).blocked.includes(ORPHAN)

    // Both are true, and they cannot both be right about who owns the file.
    expect(actorTreatsAsInstanceOwned).toBe(true)
    expect(guardForbidsEditing).toBe(true)

    // Stated as the property that SHOULD hold, so this line is the one that
    // changes when instance #8 is fixed. Asserting it directly today would
    // redden CI over a defect this test exists to describe, so the expectation
    // is inverted and carries the reason — a green run here means "the
    // disagreement is still present and still exactly this", not "all is well".
    expect(
      actorTreatsAsInstanceOwned && guardForbidsEditing,
      'When this fails, instance #8 has been fixed: the guard and planCoreUpgrade ' +
        'now agree about a path the template never shipped. Flip this to assert ' +
        'agreement (guardForbidsEditing === false, or the guard failing loudly and ' +
        'naming its own gap) and update guard-authority-inventory.ts to record the ' +
        'disagreement test as satisfied rather than descriptive.',
    ).toBe(true)
  })

  it('the guard is right whenever the template HAS shipped the file — the prefix is not the bug', async () => {
    const SHIPPED = 'services/api/real_template_file.py'
    w(base, SHIPPED, 'v1')
    w(ours, SHIPPED, 'v1')
    w(theirs, SHIPPED, 'v2')

    const plan = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: neverMerges,
    })

    // The actor carries this path: it is genuinely template-owned, and the
    // guard blocking an instance edit to it is correct. This case is what stops
    // the fix for the orphan case being "stop blocking services/api/".
    expect(plan.entries.find((e) => e.path === SHIPPED)?.orphaned).not.toBe(true)
    expect(
      checkCoreOwnership({ changedFiles: [SHIPPED], manifest: MANIFEST, isInstance: true }).blocked,
    ).toEqual([SHIPPED])
  })
})
