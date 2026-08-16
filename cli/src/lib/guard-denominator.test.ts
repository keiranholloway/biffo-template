import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { GUARD_CANDIDATE_CLASSIFICATION, discoverGuardFiles } from './guard-candidates.js'
import {
  DENOMINATOR_BASELINE_FILE,
  type DenominatorObservation,
  baselineEntriesAbsentAtBase,
  denominatorRatchet,
  observeDenominatorPrints,
  outputStatesADenominator,
  readDenominatorBaseline,
  readDenominatorBaselineAt,
  resolveBaselineBaseCommit,
} from './guard-denominator.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * #1363's closing condition, enforced forward: *a new or modified gate cannot
 * merge without stating its denominator when it passes.*
 *
 * The issue's 16 enumerated instances were each fixed individually. Nothing
 * stopped instance 17 — a new gate could ship today saying nothing about what
 * it covered, exactly as all 16 did before someone noticed. This sweep is that
 * stop. It reuses `guard-candidates.ts`'s discovery (`discoverGuardFiles`, the
 * `isGuard: true` subset every candidate is already forced through) and asks a
 * SECOND question of the same set, rather than building a parallel enumeration
 * that would drift from the first — this estate's most-repeated defect, and an
 * embarrassing one to commit in the issue about denominators.
 *
 * ## Two things a pre-merge prosecution broke in the first version, both closed here
 *
 * **1. The baseline was a bucket.** It was a `Set<string>` in this file. The
 * prosecutor added a non-printing guard (suite went red), added ONE LINE to
 * that Set in the same edit set, and it went fully green — so a PR could
 * exempt the very guard it was introducing. The baseline now lives in
 * `cli/biffo.denominator-baseline.json` and is compared against **the copy at
 * the merge base with `origin/dev`**. Removal is an improvement; ADDITION is
 * the failure. There is nothing a PR can write into its own tree that makes an
 * addition look like grandfathered debt, because the comparison is against a
 * commit the PR does not control. Same posture as `checkOrphanRatchet`
 * (`biffo.orphan-baseline.json`) and `shared-files.json`'s `skeletonAdoption`.
 *
 * **2. The detector was satisfied by code that never ran.** It walked the AST
 * for a denominator-shaped print, with no reachability analysis, so a
 * `console.log` inside `if (false)` or inside an uncalled helper both
 * registered as compliant. That detector is gone. This sweep now RUNS the
 * guards and reads what they actually printed — see `guard-denominator.ts` for
 * the two execution routes and, at length, for what neither route reaches.
 * `defeating the detector` below is the proof, executed rather than asserted.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const cliDir = join(repoRoot, 'cli')
const libDir = join(cliDir, 'src', 'lib')

/** One observation for the whole file: it spawns real check commands and a
 * child vitest run, so repeating it per test would multiply a ~15s cost by
 * the number of questions asked of it. */
let observed: DenominatorObservation
let guards: string[]
let baseline: string[]

beforeAll(() => {
  guards = discoverGuardFiles(libDir)
  baseline = readDenominatorBaseline(repoRoot)
  observed = observeDenominatorPrints(repoRoot, guards, {
    selfTestFile: 'guard-denominator.test.ts',
  })
}, 300_000)

describe('guard denominator sweep (#1363): a new or modified gate cannot merge without stating its denominator', () => {
  it('discovers at least one real guard file — a sweep that finds none is not sweeping', () => {
    console.log(`guard-denominator: ${guards.length} guard(s) discovered under cli/src/lib`)
    expect(guards.length).toBeGreaterThan(0)
  })

  it('every discovered guard was OBSERVED stating its denominator, or is named in the baseline', () => {
    const newlyFailing = observed.silent.filter((f) => !baseline.includes(f))

    // Printed unconditionally, including on a fully green run — this sweep is
    // subject to its own rule. It states what it examined, how it observed
    // them, and what it could not observe at all.
    console.log(
      `guard-denominator: examined ${guards.length} guard(s), ${observed.printing.length} ` +
        `state their own denominator when RUN, ${observed.silent.length} do not ` +
        `(${baseline.length} baselined, ${newlyFailing.length} newly unbaselined); observed by ` +
        `executing ${observed.commandsRun.length} CI-wired check command(s) and ` +
        `${guards.length} guard test file(s)`,
    )
    console.log(
      `guard-denominator: ${observed.commandsSkipped.length} wired check(s) not executable by ` +
        `this harness: ${observed.commandsSkipped.map((c) => `${c.name} — ${c.reason}`).join('; ')}`,
    )

    expect(
      newlyFailing,
      `${newlyFailing.length} guard(s) were run and printed no count, and are not in ` +
        `${DENOMINATOR_BASELINE_FILE}: ${newlyFailing.join(', ')}. This is #1363's closing ` +
        'condition: a new or modified guard cannot merge silently uncounted. Make the guard ' +
        'STATE how many things it examined when it passes — a line of real output carrying ' +
        'denominator vocabulary and a number, e.g. `audited 30 shell file(s) under scripts/` — ' +
        'reachable either from its CI-wired `biffo check` command or from its own *.test.ts. ' +
        'Adding it to the baseline instead will NOT work: that file is ratcheted against the ' +
        'merge base and an addition fails the build (see the ratchet test below).',
    ).toEqual([])
  })

  it('the baseline may only SHRINK — growing it inside this branch is itself the failure', () => {
    const baseCommit = resolveBaselineBaseCommit(repoRoot)
    expect(
      baseCommit,
      'Could not resolve a base commit (tried origin/$GITHUB_BASE_REF, origin/dev, dev), so ' +
        'this ratchet could not be evaluated at all. Cannot-tell is never a pass — run ' +
        '`git fetch origin dev` and re-run. If this is failing in CI, the checkout is not ' +
        "fetching the integration branch (ci.yml's js job uses fetch-depth: 0 precisely so " +
        'that it does).',
    ).not.toBeNull()

    const base = readDenominatorBaselineAt(repoRoot, baseCommit as string)
    const ratchet = denominatorRatchet(baseline, base)

    if (ratchet.establishing) {
      console.log(
        `guard-denominator: no baseline at ${baseCommit} — establishing one with ` +
          `${baseline.length} grandfathered guard(s). Every later branch is ratcheted against it.`,
      )
    } else {
      console.log(
        `guard-denominator: baseline ${baseline.length} entr(ies) vs ${base?.length ?? 0} at ` +
          `${baseCommit}: ${ratchet.added.length} added, ${ratchet.removed.length} removed`,
      )
    }

    if (ratchet.removed.length > 0) {
      // Improvement is reported and never failed — the same posture
      // mustBeUniform, overridesFloor and the orphan ratchet all take.
      console.log(
        `guard-denominator: ${ratchet.removed.length} guard(s) left the baseline: ` +
          `${ratchet.removed.join(', ')}. Good — that is the direction this only moves in.`,
      )
    }

    expect(
      ratchet.added,
      `${ratchet.added.join(', ')} were ADDED to ${DENOMINATOR_BASELINE_FILE} in this branch. ` +
        'The baseline records pre-existing debt and may only shrink. A guard introduced or ' +
        'modified by this PR must state its denominator, not be grandfathered by the same PR ' +
        'that introduces it — that exact move (add a non-printing guard, add one line to the ' +
        'exemption list) is what made the first version of this gate advisory rather than ' +
        'binding.',
    ).toEqual([])

    // The second condition, which binds even on the run that ESTABLISHES the
    // baseline (where the diff above is vacuously empty and would otherwise
    // let the attack through exactly once — on the change meant to stop it).
    const notPreExisting = baselineEntriesAbsentAtBase(repoRoot, baseCommit as string, baseline)
    expect(
      notPreExisting,
      `${notPreExisting.join(', ')} ${notPreExisting.length === 1 ? 'is' : 'are'} baselined in ` +
        `${DENOMINATOR_BASELINE_FILE} but did not exist at ${baseCommit}. The baseline records ` +
        'PRE-EXISTING debt; a guard this branch creates is not pre-existing and cannot be ' +
        'grandfathered by the branch that introduces it. Make it state how many things it ' +
        'examined when it passes. (If this is a rename of an already-baselined guard: a rename ' +
        'is a modification, and #1363 requires a modified gate to state its denominator — give ' +
        'it one rather than carrying the exemption across.)',
    ).toEqual([])
  })

  it('no stale baseline entries — a guard no longer discovered must be removed from the baseline', () => {
    const discovered = new Set(guards)
    const stale = baseline.filter((f) => !discovered.has(f))
    expect(
      stale,
      `${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} baselined in ` +
        `${DENOMINATOR_BASELINE_FILE} but no longer discovered as a guard (renamed, deleted, or ` +
        'reclassified isGuard:false) — remove the stale entry so the baseline stays an honest ' +
        'record of what exists today.',
    ).toEqual([])
  })

  it('reports (advisory) any baselined guard now observed printing, so the baseline can shrink', () => {
    const improved = baseline.filter((f) => observed.printing.includes(f))
    if (improved.length > 0) {
      console.log(
        `guard-denominator: ${improved.length} baselined guard(s) now state their own ` +
          `denominator and can be removed from ${DENOMINATOR_BASELINE_FILE}: ${improved.join(', ')}`,
      )
    }
    // Advisory, never a failure: nobody should be penalised for fixing more
    // than this sweep required. A ratchet that never tightens stops meaning
    // anything, which is why it is reported at all.
  })

  it('every isGuard:true candidate is covered by this sweep — no guard skips the question entirely', () => {
    const classified = Object.entries(GUARD_CANDIDATE_CLASSIFICATION)
      .filter(([, v]) => v.isGuard)
      .map(([f]) => f)
    const covered = new Set(guards)
    expect(classified.filter((f) => !covered.has(f))).toEqual([])
  })

  it('every guard is accounted for exactly once — printing, or silent-and-baselined', () => {
    // The denominator's own arithmetic, asserted rather than assumed: an
    // off-by-one here would understate the remainder, which is the defect
    // this issue is about.
    expect(observed.printing.length + observed.silent.length).toBe(guards.length)
    expect(observed.printing.filter((f) => observed.silent.includes(f))).toEqual([])
  })

  describe('defeating the detector: the dead-code bypasses that broke the static version', () => {
    /**
     * Each of these is a real module, EXECUTED with node, and judged on the
     * bytes it emitted. The first version of this gate walked the AST and
     * accepted all three of the first three: the print is textually present,
     * denominator-shaped, and interpolates a runtime value. None of them
     * prints anything when run, which is the only thing that matters and the
     * only thing now measured.
     */
    const CASES: { name: string; source: string; expectPrint: boolean }[] = [
      {
        name: 'a print inside a statically-false branch',
        source: `
export function assertFakeThing(items) {
  if (false) {
    console.log(\`examined \${items.length} item(s)\`)
  }
  if (items.length === 0) throw new Error('no items')
}
assertFakeThing(['a', 'b', 'c'])
`,
        expectPrint: false,
      },
      {
        name: 'a print inside a helper nothing calls',
        source: `
function neverCalled(items) {
  console.log(\`checked \${items.length} item(s)\`)
}
export function assertFakeThing(items) {
  if (items.length === 0) throw new Error('no items')
}
assertFakeThing(['a', 'b', 'c'])
`,
        expectPrint: false,
      },
      {
        name: 'a print that exists but is never reached on the real input',
        source: `
export function assertFakeThing(items) {
  if (items.length > 100) {
    console.log(\`audited \${items.length} item(s)\`)
  }
  if (items.length === 0) throw new Error('no items')
}
assertFakeThing(['a', 'b', 'c'])
`,
        expectPrint: false,
      },
      {
        name: 'positive control: a print that actually runs',
        source: `
export function assertFakeThing(items) {
  console.log(\`audited \${items.length} item(s)\`)
  if (items.length === 0) throw new Error('no items')
}
assertFakeThing(['a', 'b', 'c'])
`,
        expectPrint: true,
      },
    ]

    it.each(CASES)('$name', ({ source, expectPrint }) => {
      const dir = makeTmpDir('guard-denominator-deadcode')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'fake-thing-guard.mjs')
      writeFileSync(file, source)

      // Fail-first evidence, not a claim: the source really does carry a
      // denominator-shaped print in every case, including the three that
      // print nothing. A source-reading detector cannot tell them apart.
      expect(source).toMatch(/console\.log\(`(examined|checked|audited) \$\{/)

      const output = execFileSync('node', [file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(outputStatesADenominator(output)).toBe(expectPrint)
    })

    it('a comment-only mention of a count is not output either', () => {
      expect(outputStatesADenominator('// examined 25 guard(s)\n')).toBe(true)
      // ^ deliberately true: this function judges EMITTED LINES, not source.
      // The comment above can only reach it by being printed, at which point
      // it is a real (if useless) statement of a count. The distinction the
      // static detector had to make — comment vs code — does not exist here,
      // because nothing reads source at all.
    })

    it('vocabulary without a number is not a denominator', () => {
      // `check plugin-allowlist-convention` really prints this line today.
      expect(
        outputStatesADenominator('audited the plugin-allowlist naming convention under /repo\n'),
      ).toBe(false)
      expect(outputStatesADenominator('audited 30 shell file(s) under scripts/\n')).toBe(true)
    })
  })

  describe('fail-first: the ratchet, against real git rather than a fixture of git', () => {
    const REL = 'baseline.json'
    const write = (repo: string, entries: string[]): void =>
      writeFileSync(join(repo, REL), `${JSON.stringify({ noDenominator: entries }, null, 2)}\n`)

    const makeRepo = (): string => {
      const repo = makeTmpDir('denominator-ratchet')
      mkdirSync(repo, { recursive: true })
      const g = (args: string[]): void => {
        execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
      }
      g(['init', '-q', '-b', 'dev'])
      g(['config', 'user.email', 'test@example.com'])
      g(['config', 'user.name', 'Test'])
      mkdirSync(join(repo, 'guards'), { recursive: true })
      writeFileSync(join(repo, 'guards', 'legacy-guard.ts'), 'export const legacy = 1\n')
      write(repo, ['legacy-guard.ts'])
      g(['add', '-A'])
      g(['commit', '-q', '-m', 'baseline'])
      g(['checkout', '-q', '-b', 'topic'])
      return repo
    }

    it('FAILS when a branch appends to the baseline — the exact move that broke the first version', () => {
      const repo = makeRepo()
      // A PR adding a non-printing guard and grandfathering it in the same
      // edit set. Under the old Set-in-the-test-file scheme this was green.
      write(repo, ['legacy-guard.ts', 'fake-thing-guard.ts'])
      execFileSync('git', ['-C', repo, 'commit', '-qam', 'add guard + exempt it'], {
        stdio: 'ignore',
      })

      const base = readDenominatorBaselineAt(repo, 'dev', REL)
      const working = readDenominatorBaselineAt(repo, 'topic', REL)
      const ratchet = denominatorRatchet(working as string[], base)

      expect(ratchet.added).toEqual(['fake-thing-guard.ts'])
      expect(ratchet.establishing).toBe(false)
    })

    it('PASSES when the branch only removes entries', () => {
      const repo = makeRepo()
      write(repo, [])
      execFileSync('git', ['-C', repo, 'commit', '-qam', 'guard now prints; unbaseline it'], {
        stdio: 'ignore',
      })

      const ratchet = denominatorRatchet(
        readDenominatorBaselineAt(repo, 'topic', REL) as string[],
        readDenominatorBaselineAt(repo, 'dev', REL),
      )
      expect(ratchet.added).toEqual([])
      expect(ratchet.removed).toEqual(['legacy-guard.ts'])
    })

    it('FAILS on a branch-created guard even when the baseline is being ESTABLISHED', () => {
      // The bootstrap hole: with no baseline at the base commit there is no
      // diff to fail on, so the append check alone would let the attack land
      // exactly once — on the change that introduces the ratchet. This is the
      // condition that binds anyway.
      const repo = makeRepo()
      writeFileSync(join(repo, 'guards', 'fake-thing-guard.ts'), 'export const fake = 1\n')
      write(repo, ['legacy-guard.ts', 'fake-thing-guard.ts'])
      execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'add guard + exempt it'], {
        stdio: 'ignore',
      })

      const entries = readDenominatorBaselineAt(repo, 'topic', REL) as string[]
      expect(baselineEntriesAbsentAtBase(repo, 'dev', entries, 'guards')).toEqual([
        'fake-thing-guard.ts',
      ])
      // …and the pre-existing entry is untouched, so day-one debt never blocks.
      expect(baselineEntriesAbsentAtBase(repo, 'dev', ['legacy-guard.ts'], 'guards')).toEqual([])
    })

    it('an absent baseline at the base commit is "establishing", not an empty comparison', () => {
      // The distinction that keeps the first introduction of the file from
      // reading as "everything was added", and keeps a missing file from
      // silently permitting anything afterwards.
      const repo = makeRepo()
      expect(readDenominatorBaselineAt(repo, 'dev', 'no-such-file.json')).toBeNull()
      expect(denominatorRatchet(['a.ts'], null)).toEqual({
        added: [],
        removed: [],
        establishing: true,
      })
    })

    it('a malformed baseline throws rather than degrading to an empty set', () => {
      const repo = makeRepo()
      writeFileSync(join(repo, REL), '{"noDenominator": "not-an-array"}\n')
      execFileSync('git', ['-C', repo, 'commit', '-qam', 'break it'], { stdio: 'ignore' })
      expect(() => readDenominatorBaselineAt(repo, 'topic', REL)).toThrow(/invalid/)
      // Degrading to `[]` would make every working entry read as an addition
      // (a surprise hard block) — or, if the degradation happened on the
      // working side instead, would silently permit every addition.
    })
  })

  it('examined 0: an empty input is a STATED outcome, not a silent pass', () => {
    const dir = makeTmpDir('guard-denominator-empty')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'not-a-guard.ts'), 'export const answer = 42\n')

    const found = discoverGuardFiles(dir)
    const message =
      `guard-denominator: examined ${found.length} guard(s), 0 state their own denominator ` +
      'when RUN, 0 do not (0 baselined, 0 newly unbaselined)'
    console.log(message)

    expect(found).toEqual([])
    expect(message).toContain('examined 0 guard(s)')
    // Zero is a pass here — there is nothing to demand a print of — but it is
    // a STATED pass, which is the only thing separating it from a sweep that
    // found nothing and reported green regardless.
  })
})
