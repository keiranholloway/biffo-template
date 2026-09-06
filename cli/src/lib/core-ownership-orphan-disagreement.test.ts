import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import { checkCoreOwnership } from './core-ownership-guard.js'
import { type MergeFileFn, planCoreUpgrade } from './core-upgrade.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * The disagreement test for `core-ownership-guard`, instance #8 of class #1362
 * ("a guard resolves its answer from a different document than the actor it is
 * guarding"). Fixed by #1912.
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
 * those two used to answer differently — and the guard was the one acting on a
 * document the upgrade does not use.
 *
 * ## Why this was a defect and not a pair of opinions
 *
 * The guard did not merely disagree; **it blocked a commit with an instruction
 * that could not be followed.** Its refusal said the change belonged upstream in
 * `biffo-template`. The file does not exist upstream, so there was no change to
 * make there. Worse, the guard's own printed escape hatch — a `Core-Divergence:`
 * trailer — accepted ANY reason for ANY path under the prefix, so the only way
 * past was to record, in history, that the instance "deliberately diverges"
 * from a template file that was never real (#1912).
 *
 * That is exactly the shape #1362 exists to catch, and it is instance #8's own
 * report: *"it blocked a commit and told the author to make the change in a
 * repo where the file does not exist"*, followed the next day by *"second
 * occurrence — same day, different file. This is not a one-off mis-scoped
 * path."*
 *
 * ## The fix: give the guard a real (optional) view of what ships
 *
 * `checkCoreOwnership` now accepts `templateShippedPaths` — the template's real
 * `dev`-branch tree, fetched live by the CI runner
 * (`template-shipped-paths.ts`), never by the offline-safe commit-msg hook. When
 * supplied, a manifest-prefix match the real tree does not contain is reported
 * as a `knownOrphan` and treated exactly as `classify()` treats it: instance-
 * owned, never blocked, no trailer needed or accepted as an excuse for
 * something that was never really a divergence. When NOT supplied (the hook,
 * or a CI run where the network fetch failed), behaviour is unchanged from
 * before this fix — `undefined`/`null` is "could not tell", never "ships
 * nothing" (see `fetchTemplateShippedPaths`'s own doc for why collapsing those
 * two would be its own fail-open bug).
 *
 * ## What this test asserts, and why it is written as agreement
 *
 * It builds ONE state and asks BOTH sides. It does not re-implement either
 * side's rule: `planCoreUpgrade` is driven over real directories so the actor's
 * answer is the shipping one, and `checkCoreOwnership` is called with the same
 * manifest the upgrade was planned with, and a `templateShippedPaths` set
 * derived by actually walking those same `base`/`theirs` directories on disk —
 * not by re-deriving "is this an orphan?" from a second predicate. A test that
 * recomputed that from its own predicate would be agreeing with itself — the
 * `_in_step_snapshot` mistake recorded on `biffo-plugin-marketing#175`, where a
 * fixture built from the code under test could not fail with it.
 */

/** Every repo-relative posix path under `root`, recursively. Used to build the
 *  test's own `templateShippedPaths` set by actually reading the `base`/
 *  `theirs` fixture directories, rather than asserting from a second, hand-
 *  maintained list of what "should" be there. */
function listAllFiles(root: string): string[] {
  const out: string[] = []
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) out.push(relative(root, abs).split(sep).join('/'))
    }
  }
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root)
  return out
}

/** classify()'s own orphan condition is `!inBase && !inTheirs` — a path counts
 *  as "shipped" if EITHER tree has it (removed-upstream is a different branch,
 *  `inBase && !inTheirs`, not an orphan). Mirrors that by union, not by
 *  guessing which single tree matters. */
function shippedPaths(...roots: string[]): Set<string> {
  return new Set(roots.flatMap(listAllFiles))
}

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

  it('without a template view (the old, still-supported default) the guard still blocks it', () => {
    // Every caller that predates #1912 — the commit-msg hook today, and every
    // test written before this fix — omits `templateShippedPaths` and must see
    // EXACTLY the pre-fix behaviour, unchanged. `undefined` is "could not
    // tell", not "nothing is shipped".
    const result = checkCoreOwnership({
      changedFiles: [ORPHAN],
      manifest: MANIFEST,
      isInstance: true,
    })

    expect(result.skipped).toBeNull()
    expect(result.blocked).toEqual([ORPHAN])
    expect(result.knownOrphans).toEqual([])
  })

  it('AGREEMENT (was DISAGREEMENT): with a real template view, the guard agrees with the upgrade', async () => {
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

    // The guard's own real-tree view, built the same way the CI runner builds
    // it (template-shipped-paths.ts) — the union of what `base` and `theirs`
    // actually contain on disk, read directly rather than re-derived from a
    // second "is this an orphan?" predicate.
    const result = checkCoreOwnership({
      changedFiles: [ORPHAN],
      manifest: MANIFEST,
      isInstance: true,
      templateShippedPaths: shippedPaths(base, theirs),
    })

    expect(actorTreatsAsInstanceOwned).toBe(true)
    // This is the line that used to be the recorded disagreement (asserted
    // inverted, on purpose, so a green run meant "still broken"). It is now
    // asserted directly: the guard agrees with `classify()` rather than
    // blocking a commit with an instruction ("make the change upstream") that
    // could never be followed.
    expect(result.blocked).toEqual([])
    expect(result.knownOrphans).toEqual([ORPHAN])
  })

  it(
    'FAIL-FIRST (#1912): a Core-Divergence trailer used to be accepted for the orphan; ' +
      'with a real template view it is no longer needed, and no divergence is ever recorded',
    () => {
      const trailerMessage =
        'fix(api): add an instance-only route\n\n' +
        'Core-Divergence: instance_only_route.py is ours alone\n'

      // Before #1912 (and still true today when no template view is
      // available, e.g. the offline commit-msg hook): the guard cannot tell
      // this path apart from a genuine template file under the same prefix,
      // so ANY Core-Divergence trailer excuses it — wrongly recording
      // "deliberate divergence from a real template file" for a file the
      // template never shipped at all.
      const withoutTemplateView = checkCoreOwnership({
        changedFiles: [ORPHAN],
        manifest: MANIFEST,
        isInstance: true,
        commitMessage: trailerMessage,
      })
      expect(withoutTemplateView.skipped).toBe('divergence-trailer')
      expect(withoutTemplateView.divergenceReason).not.toBeNull()

      // With the CI runner's real template view, the guard already knows this
      // is instance-owned before it ever looks at the commit message — the
      // trailer becomes unnecessary, and no false "divergence" is recorded for
      // something that was never a divergence from anything real.
      const withTemplateView = checkCoreOwnership({
        changedFiles: [ORPHAN],
        manifest: MANIFEST,
        isInstance: true,
        commitMessage: trailerMessage,
        templateShippedPaths: new Set(), // the template ships nothing named this
      })
      expect(withTemplateView.skipped).toBeNull()
      expect(withTemplateView.blocked).toEqual([])
      expect(withTemplateView.knownOrphans).toEqual([ORPHAN])
      // The trailer was present but never needed to excuse anything — no
      // divergence is reported as the reason the change was allowed.
      expect(withTemplateView.divergenceReason).toBeNull()
    },
  )

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
    // the fix for the orphan case being "stop blocking services/api/" — a real
    // template view must not turn every template-owned path into a free pass.
    expect(plan.entries.find((e) => e.path === SHIPPED)?.orphaned).not.toBe(true)
    const result = checkCoreOwnership({
      changedFiles: [SHIPPED],
      manifest: MANIFEST,
      isInstance: true,
      templateShippedPaths: shippedPaths(base, theirs),
    })
    expect(result.blocked).toEqual([SHIPPED])
    expect(result.knownOrphans).toEqual([])
  })
})
