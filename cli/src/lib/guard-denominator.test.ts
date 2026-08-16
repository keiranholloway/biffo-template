import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GUARD_CANDIDATE_CLASSIFICATION, discoverGuardFiles } from './guard-candidates.js'
import { guardPrintsDenominator, sourceDeclaresDenominatorPrint } from './guard-denominator.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * The second signal on #1519's discovery+classification mechanism, for
 * class issue #1363: "a gate in this estate cannot report green without
 * either covering its whole input or naming what it skipped."
 *
 * #1363's own history has 16 enumerated instances and, as of the issue's
 * 2026-08-16 re-scope comment, all of them individually fixed or absorbed —
 * but nothing stopped instance 17. A new gate could still ship today
 * printing nothing about what it covered, exactly as every one of the 16
 * did before someone noticed. This sweep is that stop: it reuses
 * `guard-candidates.ts`'s existing discovery (`discoverGuardFiles`, the
 * `isGuard: true` subset `GUARD_CANDIDATE_CLASSIFICATION` already forces
 * every candidate through) and asks a SECOND question of the same set —
 * does it print its denominator when it passes? — rather than building a
 * parallel enumeration. A second discovery mechanism drifting from the
 * first is this estate's own most-repeated defect class (see AGENTS.md's
 * framing: `_extract_detail` written twice, `AGENTS.md` absent from eleven
 * of seventeen repos, four divergent `in-progress` label descriptions), and
 * building one here — for the issue about denominators, of all issues —
 * would be exactly that.
 *
 * ## What "prints a denominator" means, and how it is checked
 *
 * `guard-denominator.ts`'s `sourceDeclaresDenominatorPrint` is a STATIC,
 * AST-based detector (never a regex over source text, #956): a print call
 * or a constructed report string, containing denominator vocabulary
 * ("checked", "audited", "examined", ...) beside a runtime-computed value —
 * never a hardcoded string that merely uses the right words. See that
 * module's docstring for the two shapes it recognises and why report-STRING
 * construction (not only a literal `console.log` call) counts: this repo's
 * real convention is a guard building a `format*` report string and a
 * command-layer caller printing it, and `shared-file-reduction-guard.ts`'s
 * `formatReductionReport` — the one guard in this survey that already does
 * this — is the proof the detector recognises the real shape, not only a
 * synthetic one (see the positive-control test below).
 *
 * `guardPrintsDenominator` checks a guard's own `.ts` file and its
 * same-basename `.test.ts` pair ONLY. It deliberately does not trace into
 * arbitrary third-party callers (a `cli/src/commands/` wrapper importing the
 * guard, or — the exact shape the fail-first proof below is built from — a
 * DIFFERENT test file such as `template-owned-scope.test.ts` importing
 * `python-test-scope-scan.ts`). That is a real, named exclusion, not a
 * silent one: building the reverse-import graph needed to reach those
 * callers is `guard-wiring-sweep.test.ts`'s job (#1413), not duplicated
 * here, and joining the two is future work. A guard whose only denominator
 * print lives in such a caller is therefore correctly reported as NOT
 * detected by this mechanism and must sit in the baseline below, visibly,
 * rather than pass on a caller this check cannot see.
 *
 * ## What this sweep does NOT claim
 *
 * It does not claim all 25 currently-classified guards have been read
 * end-to-end to determine whether they are "sweep-shaped" (iterate a
 * variable-size input) at all — some plainly are not (a guard validating one
 * commit subject, or one migration's two git revisions, has no natural
 * count to state). Sorting that out per guard is a second, separate piece
 * of work #1363 does not ask for: the issue's closing condition is the
 * FORWARD-enforcing mechanism ("a new or modified gate cannot merge without
 * asserting it prints a denominator when it passes"), which this sweep
 * builds and enforces via the ratchet below — not a retroactive audit of
 * which of the 25 genuinely need one. Every one of the 24 that does not
 * mechanically pass today is named in `PRE_EXISTING_NO_DENOMINATOR`, so the
 * remainder is visible and shrinkable rather than silently narrowed.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const libDir = join(repoRoot, 'cli', 'src', 'lib')

/**
 * Every `isGuard: true` guard that does not YET mechanically pass
 * `guardPrintsDenominator`, as of this file's authorship — grandfathered in
 * by name, the same shape `guard-wiring-sweep.test.ts`'s
 * `PRE_EXISTING_UNWIRED` uses for #1413 (currently empty there, having
 * shrunk from 5 to 0 as each was wired — the same trajectory this baseline
 * is meant to follow).
 *
 * A guard on this list may print its denominator through a route this
 * check cannot see (a command-layer caller — see the module docstring
 * above), may have no natural denominator to print (a single
 * fixed-condition check), or may simply not have been given one yet. This
 * sweep does not adjudicate which; it only insists nothing NEW joins this
 * set silently, and that nothing REMOVED from it lingers here stale.
 */
const PRE_EXISTING_NO_DENOMINATOR = new Set<string>([
  'adr-numbering-guard.ts',
  'branch-protection-audit.ts',
  'build-freshness.ts',
  'claim-invocation-parity.ts',
  'codeql-suppression-guard.ts',
  'cognito-invite-template-guard.ts',
  'core-direct-paths-audit.ts',
  'core-ownership-guard.ts',
  'core-upgrade-target-fidelity.ts',
  'doctor.ts',
  'eventbridge-log-permission-guard.ts',
  'instance-adoption.ts',
  'lambda-output-guard.ts',
  'migration-body-change-guard.ts',
  'pipe-trap-guard.ts',
  'plugin-allowlist-convention.ts',
  'plugin-collision-guard.ts',
  'plugin-staleness.ts',
  'plugin-terraform-guard.ts',
  'plugin-tool-supply-audit.ts',
  'release-subject-guard.ts',
  'sibling-identity-check.ts',
  'skeleton-drift-guard.ts',
  'terraform-input-guard.ts',
])

describe('guard denominator sweep (#1363): a new or modified gate cannot merge without asserting it prints a denominator', () => {
  it('discovers at least one real guard file — examined 0 is a real, printed outcome, not silence', () => {
    const found = discoverGuardFiles(libDir)
    // #1519's own denominator requirement, applied to THIS sweep: state the
    // count even when it is zero. If `found` were empty (e.g. run against an
    // empty/unreadable directory), the line below still executes and says
    // "0 guard(s) discovered" rather than the suite quietly reporting no
    // failures — see the dedicated `examined 0` test below for the case this
    // guards against directly, against a real empty directory rather than
    // asserting it of THIS repo's (necessarily non-empty) tree.
    console.log(`guard-denominator: ${found.length} guard(s) discovered under cli/src/lib`)
    expect(found.length).toBeGreaterThan(0)
  })

  it('every discovered guard mechanically prints its own denominator, or is named in the baseline', () => {
    const guards = discoverGuardFiles(libDir)
    const passing = guards.filter((f) => guardPrintsDenominator(libDir, f))
    const failing = guards.filter((f) => !guardPrintsDenominator(libDir, f))
    const newlyFailing = failing.filter((f) => !PRE_EXISTING_NO_DENOMINATOR.has(f))

    // Printed unconditionally — the actual acceptance criterion from the
    // dispatch brief: "examined N gates ... could not classify M", stated
    // even on a fully green run.
    console.log(
      `guard-denominator: examined ${guards.length} guard(s), ${passing.length} print their own ` +
        `denominator, ${failing.length} do not (${PRE_EXISTING_NO_DENOMINATOR.size} baselined, ` +
        `${newlyFailing.length} newly unbaselined)`,
    )

    expect(
      newlyFailing,
      `${newlyFailing.length} guard(s) print no denominator and are not in ` +
        `PRE_EXISTING_NO_DENOMINATOR: ${newlyFailing.join(', ')}. This is #1363's own closing ` +
        'condition: a new or modified guard cannot merge silently uncounted. Either make the ' +
        'guard state how many things it examined when it passes (a console.log/format* report ' +
        'string containing a runtime-computed count — see guard-denominator.ts for the exact ' +
        'shape recognised), or — if it genuinely has no natural denominator (a single ' +
        'fixed-condition check) or prints one through a command-layer caller this check cannot ' +
        'see — add it to PRE_EXISTING_NO_DENOMINATOR above with a comment stating which.',
    ).toEqual([])
  })

  it('no stale baseline entries — a guard no longer discovered must be removed from the baseline', () => {
    const guards = new Set(discoverGuardFiles(libDir))
    const stale = [...PRE_EXISTING_NO_DENOMINATOR].filter((f) => !guards.has(f))
    expect(
      stale,
      `${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} baselined in ` +
        'PRE_EXISTING_NO_DENOMINATOR but no longer discovered as a guard (renamed, deleted, or ' +
        'reclassified isGuard:false) — remove the stale entry so the baseline stays an honest ' +
        'record of what exists today, the same hygiene guard-candidates.test.ts already applies ' +
        'to GUARD_CANDIDATE_CLASSIFICATION.',
    ).toEqual([])
  })

  it('reports (advisory) any baselined guard that now mechanically passes, so the baseline can shrink', () => {
    const improved = [...PRE_EXISTING_NO_DENOMINATOR].filter((f) =>
      guardPrintsDenominator(libDir, f),
    )
    if (improved.length > 0) {
      console.log(
        `guard-denominator: ${improved.length} baselined guard(s) now print their own ` +
          `denominator and can be removed from PRE_EXISTING_NO_DENOMINATOR: ${improved.join(', ')}`,
      )
    }
    // Advisory only, same posture as shared-sync's overridesFloor/mustBeUniform
    // ratchets: an improvement is reported, never failed, so nobody is
    // penalised for fixing more than this sweep required.
  })

  it('every isGuard:true candidate from guard-candidates.ts is covered by this sweep — no guard skips the question entirely', () => {
    const classified = Object.entries(GUARD_CANDIDATE_CLASSIFICATION)
      .filter(([, v]) => v.isGuard)
      .map(([f]) => f)
    const covered = new Set([...discoverGuardFiles(libDir)])
    const uncovered = classified.filter((f) => !covered.has(f))
    // discoverGuardFiles already IS the isGuard:true subset of
    // GUARD_CANDIDATE_CLASSIFICATION (see guard-candidates.ts), so this can
    // only fail if the two functions disagree with each other — a
    // regression test for that invariant, not a new enumeration.
    expect(uncovered).toEqual([])
  })

  describe("fail-first proof, against this repo's own real history (#1454, commit aba5d63d)", () => {
    /**
     * `cli/src/lib/template-owned-scope.test.ts`'s `it.each` callback for the
     * #325/#327 META guard, BEFORE #1454 (`git show aba5d63d^:cli/src/lib/
     * template-owned-scope.test.ts`, lines 84-94 of that revision). It
     * asserted `reached.length` was non-zero but never STATED the count —
     * exactly the class #1363 is about, in this repo's own tree, not a
     * synthetic stand-in.
     */
    const PARENT_DEFECTIVE_SOURCE = `
  it.each(applicableScanners)(
    '$name reaches only template-owned paths',
    ({ scan, allowedUnowned }) => {
      const reached = scan(repoRoot)
      // The guard must actually reach something — a scanner that finds nothing
      // would pass this vacuously and hide a broken walk.
      expect(reached.length).toBeGreaterThan(0)
      const unowned = reached.filter(
        (p) => !isTemplateOwned(p, manifest) && !(allowedUnowned && allowedUnowned(p)),
      )
      expect(unowned).toEqual([])
    },
`

    /**
     * The same callback AFTER aba5d63d (`git show aba5d63d:cli/src/lib/
     * template-owned-scope.test.ts`, lines 115-128 of that revision) — one
     * line added, the guard's own commit message calling it out explicitly:
     * "Coverage counts are now printed per scanner rather than merely
     * asserted non-zero".
     */
    const FIX_SOURCE = `
  it.each(applicableScanners)(
    '$name reaches only template-owned paths',
    ({ name, scan, allowedUnowned }) => {
      const reached = scan(repoRoot)
      // The guard must actually reach something — a scanner that finds nothing
      // would pass this vacuously and hide a broken walk. Printed, not just
      // asserted-nonzero: a scanner that runs and matches nothing looks
      // identical to one that runs and finds no problems, and that confusion
      // is exactly what left this META guard blind to Python for as long as
      // it was (#1454).
      console.log(\`  [coverage] \${name}: \${reached.length} path(s) reached\`)
      expect(reached.length).toBeGreaterThan(0)
      const unowned = reached.filter(
`

    it('fires on the pre-fix parent (aba5d63d^) — no denominator print present', () => {
      expect(sourceDeclaresDenominatorPrint(PARENT_DEFECTIVE_SOURCE)).toBe(false)
    })

    it('is silent on the fix (aba5d63d) — the added console.log is detected', () => {
      expect(sourceDeclaresDenominatorPrint(FIX_SOURCE)).toBe(true)
    })
  })

  it('positive control: a real guard already in this repo that prints its own denominator today', () => {
    // shared-file-reduction-guard.ts's formatReductionReport builds
    // `shared-file reduction check: ${report.analysed.length} mapping(s)
    // analysed, ${report.skipped.length} not analysable` — proof the
    // detector recognises the REPORT-STRING shape this repo actually uses
    // (a `format*` function returning the count for a caller to print), not
    // only a direct console.log call. Without this shape the detector would
    // report false for every guard in the survey, which would have looked
    // suspiciously uniform rather than a real, checked result.
    expect(guardPrintsDenominator(libDir, 'shared-file-reduction-guard.ts')).toBe(true)
  })

  it('examined 0 behaviour: the sweep states "examined 0" rather than passing silently over an empty input', () => {
    // The exact failure shape #1413 named for the wiring sweep, applied to
    // this one: a directory with nothing guard-shaped in it must not read
    // the same as "all guards passed" — it must STATE that zero were
    // examined. Mirrors the main sweep's own computation and message shape
    // (`examined ${guards.length} guard(s) ...`) against a real empty
    // directory rather than asserting it only of this repo's own
    // (necessarily non-empty) tree.
    const dir = makeTmpDir('guard-denominator-empty')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'not-a-guard.ts'), 'export const answer = 42\n')

    const guards = discoverGuardFiles(dir)
    const passing = guards.filter((f) => guardPrintsDenominator(dir, f))
    const failing = guards.filter((f) => !guardPrintsDenominator(dir, f))
    const message =
      `guard-denominator: examined ${guards.length} guard(s), ${passing.length} print their own ` +
      `denominator, ${failing.length} do not (0 baselined, 0 newly unbaselined)`
    console.log(message)

    expect(guards).toEqual([])
    expect(message).toContain('examined 0 guard(s)')
    // Zero examined is a PASS here (there is nothing to demand a print of),
    // but it is a stated, printed pass — not the same thing as a suite that
    // silently found nothing to check and reported green regardless.
  })
})
