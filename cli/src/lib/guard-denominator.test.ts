import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { GUARD_CANDIDATE_CLASSIFICATION, discoverGuardFiles } from './guard-candidates.js'
import * as head from './guard-denominator.js'
import {
  type BaselineBase,
  DENOMINATOR_BASELINE_FILE,
  DENOMINATOR_MECHANISM_FILE,
  type DenominatorObservation,
  outputStatesADenominator,
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
 * ## Three things independent pre-merge prosecutions broke, and where each went
 *
 * **1. The baseline was a bucket** (round 1). A `Set<string>` in this file: add
 * a non-printing guard, add one line to the Set in the same edit, green. The
 * baseline now lives in `cli/biffo.denominator-baseline.json` and is ratcheted
 * against the copy at the merge base. Removal is an improvement; ADDITION is
 * the failure, and `baselineEntriesAbsentAtBase` binds even on the run that
 * establishes the file.
 *
 * **2. The detector was satisfied by code that never ran** (round 1). It walked
 * the AST for a denominator-shaped print with no reachability analysis, so a
 * `console.log` inside `if (false)` or inside an uncalled helper both counted.
 * That detector is gone: the sweep RUNS the guards and reads the bytes they
 * emitted. `defeating the detector` below is that proof, executed.
 *
 * **3. The mechanism could edit what constrained it** (round 2). One line in
 * the merge-base resolver, returning the PR's own `HEAD`, made the ratchet
 * compare the baseline against itself and a new non-printing guard went 19/19
 * green. The fix is not a sharper detector — it is that *what measures* now
 * comes from the base ref while *what is measured* comes from HEAD, and that
 * the resolved base commit is **verified against a property this branch cannot
 * fabricate** rather than trusted. See `guard-denominator.ts` for the full
 * argument, including the part of this that is still not bound and cannot be
 * from inside the checkout.
 *
 * Round 2 also broke route 2 (a guard credited by a count its own *test file*
 * printed). Route 2 is deleted rather than repaired — it credited zero of 25
 * guards, and zero of the 25 guard test files contain a `console.` call at
 * all, so its only effect on any real input was the forge.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const cliDir = join(repoRoot, 'cli')
const libDir = join(cliDir, 'src', 'lib')

/** The subset of this module's surface the sweep drives. A copy loaded from
 * the base ref must supply all of it, or the load is refused with a legible
 * error instead of a `TypeError` deep inside a test. */
const REQUIRED_MECHANISM_EXPORTS = [
  'observeDenominatorPrints',
  'denominatorRatchet',
  'baselineEntriesAbsentAtBase',
  'readDenominatorBaseline',
  'readDenominatorBaselineAt',
] as const

type Mechanism = typeof head

/** One observation for the whole file: it spawns real check commands, so
 * repeating it per test would multiply a ~15s cost by the number of questions
 * asked of it. */
let guards: string[]
let baseline: string[]
let base: BaselineBase | null
let headSha: string | null
/** The copy that DECIDES — base's whenever one exists. */
let mechanism: Mechanism
let mechanismProvenance: string
let rootOfTrustError: string | null = null
let observed: DenominatorObservation
/** Head's own verdict, computed only when head's copy differs from base's, so
 * that a mechanism edit cannot land unexercised by the run that merges it. */
let headObserved: DenominatorObservation | null = null
let baseBlob: string | null = null
let headBlob: string | null = null

async function loadMechanismAt(commit: string): Promise<Mechanism | null> {
  const file = head.extractFileAtCommit(
    repoRoot,
    commit,
    DENOMINATOR_MECHANISM_FILE,
    makeTmpDir('guard-denominator-base'),
  )
  if (file === null) return null
  const loaded = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Partial<Mechanism>
  const missing = REQUIRED_MECHANISM_EXPORTS.filter((name) => typeof loaded[name] !== 'function')
  if (missing.length > 0) {
    throw new Error(
      `${DENOMINATOR_MECHANISM_FILE} at ${commit} does not export ${missing.join(', ')}. The ` +
        'sweep runs the base ref’s copy of the mechanism, so renaming or removing an export ' +
        'that this test drives breaks the load. Keep the surface in ' +
        'REQUIRED_MECHANISM_EXPORTS stable, or land the rename in a PR that also updates it.',
    )
  }
  return loaded as Mechanism
}

beforeAll(async () => {
  guards = discoverGuardFiles(libDir)

  // ── The root of trust, and its verification ──────────────────────────────
  // Something in the head checkout has to bootstrap: the base commit must be
  // resolved before anything can be loaded from it. So the resolution is not
  // trusted — its RESULT is checked against facts a branch cannot fabricate.
  base = head.resolveBaselineBase(repoRoot)
  headSha = head.resolveHeadCommit(repoRoot)
  const allowedRefs = head.integrationRefCandidates()

  if (base === null) {
    rootOfTrustError =
      'Could not resolve a base commit (tried ' +
      `${allowedRefs.join(', ')}), so neither the ratchet nor the base-ref mechanism could be ` +
      'evaluated at all. Cannot-tell is never a pass — run `git fetch origin dev` and ' +
      "re-run. In CI this means the checkout is not fetching the integration branch (ci.yml's " +
      'js job uses fetch-depth: 0 precisely so that it does).'
  } else if (!allowedRefs.includes(base.ref)) {
    rootOfTrustError =
      `the base was resolved via ref ${base.ref}, which is not on the integration list ` +
      `(${allowedRefs.join(', ')}) recomputed independently here`
  } else if (headSha !== null && base.commit === headSha) {
    rootOfTrustError =
      `the base commit resolved to HEAD itself (${headSha}), so the ratchet would compare this ` +
      'branch against itself'
  } else if (!head.baseCommitIsContainedIn(repoRoot, base.commit, base.ref)) {
    rootOfTrustError =
      `the base commit ${base.commit} is NOT contained in ${base.ref}, so it is a commit this ` +
      'branch authored rather than one the integration branch already carries'
  }

  // ── Load the copy that decides ───────────────────────────────────────────
  let loaded: Mechanism | null = null
  if (base !== null && rootOfTrustError === null) {
    loaded = await loadMechanismAt(base.commit)
    baseBlob = head.blobShaAtCommit(repoRoot, base.commit, DENOMINATOR_MECHANISM_FILE)
  }
  headBlob = head.blobShaOfWorkingFile(repoRoot, DENOMINATOR_MECHANISM_FILE)

  mechanism = loaded ?? head
  // Derived from the binding that actually decided, never asserted alongside
  // it. An earlier draft computed this from `loaded`, and a rehearsal of the
  // "edit the harness" attack made it print "base’s copy supplied the verdict"
  // on a run where head's copy had. A provenance line that can disagree with
  // what acted is the #1362 guard-vs-authority defect in the log itself.
  mechanismProvenance =
    (mechanism as unknown) !== (head as unknown)
      ? `base ${base?.commit.slice(0, 12)} (blob ${baseBlob?.slice(0, 12)})`
      : rootOfTrustError !== null
        ? 'HEAD — the base commit was REJECTED, so nothing was loaded from it'
        : baseBlob !== null
          ? 'HEAD — although a copy EXISTS at the base commit and was not used'
          : `HEAD — no copy of ${DENOMINATOR_MECHANISM_FILE} at the base commit (establishing run)`

  baseline = mechanism.readDenominatorBaseline(repoRoot)
  observed = mechanism.observeDenominatorPrints(repoRoot, guards)

  // Head's copy is exercised too whenever it differs, so an edit to the
  // mechanism cannot land untested by the run that merges it.
  if (loaded !== null && baseBlob !== headBlob) {
    headObserved = head.observeDenominatorPrints(repoRoot, guards)
  }
}, 600_000)

describe('guard denominator sweep (#1363): a new or modified gate cannot merge without stating its denominator', () => {
  it('the base commit is one the integration branch already carries — not one this branch authored', () => {
    // The round-2 defeat, closed. `resolveBaselineBase` can be rewritten to
    // return anything; this asks whether the answer is a commit already on
    // `origin/dev`, which no commit unique to a PR branch ever is.
    console.log(
      `guard-denominator: base ${base?.commit.slice(0, 12) ?? 'UNRESOLVED'} via ` +
        `${base?.ref ?? 'n/a'}; HEAD ${headSha?.slice(0, 12) ?? 'unknown'}; mechanism from ` +
        `${mechanismProvenance}; trigger ${head.isPullRequestRun() ? 'pull_request' : 'push (or local)'}` +
        (base?.viaPushFirstParent === true
          ? '; push-fallback USED — base resolved to HEAD (expected right after this branch’s ' +
            'own merge), so its first parent was compared against instead of rejecting (#1629)'
          : '; push-fallback not used'),
    )
    expect(
      rootOfTrustError,
      `Root of trust rejected: ${rootOfTrustError}. The sweep loads ` +
        `${DENOMINATOR_MECHANISM_FILE} from the merge base and lets THAT copy decide, so the ` +
        'resolved base commit is the one thing a branch could otherwise choose for itself. ' +
        'It is therefore verified rather than trusted.',
    ).toBeNull()
  })

  it('states which revision of the mechanism decided this run', () => {
    // Answering "which document acted, and from which revision" in the log
    // itself, which is the visibility an acknowledgement trailer would have
    // bought at a cost paid only by honest authors.
    const diverged = baseBlob !== null && baseBlob !== headBlob
    console.log(
      `guard-denominator: mechanism ${DENOMINATOR_MECHANISM_FILE} — decided by ` +
        `${mechanismProvenance}; base blob ` +
        `${baseBlob?.slice(0, 12) ?? 'ABSENT'}, head blob ${headBlob?.slice(0, 12) ?? 'unknown'}` +
        (diverged
          ? '. THIS BRANCH EDITS THE MECHANISM, so head’s copy was run as well and must pass too.'
          : rootOfTrustError !== null
            ? '. The base was rejected, so no copy was read from it and the verdict below is ' +
              'NOT binding — the rejection above is.'
            : baseBlob === null
              ? '. Establishing run — head’s copy decided, because there is none at base.'
              : '. Identical, so the distinction did not matter on this run.'),
    )
    expect(headBlob).not.toBeNull()

    // Whenever a base copy exists and was accepted, it MUST be the one that
    // decided. Rehearsing the "edit the harness" attack showed the cheapest
    // form of it is a single `mechanism = head`, which leaves every other
    // signal — the base commit, the blob SHAs, the root-of-trust check — fully
    // intact and honest-looking. This is the one assertion that notices.
    if (baseBlob !== null && rootOfTrustError === null) {
      expect(
        (mechanism as unknown) === (head as unknown),
        `A copy of ${DENOMINATOR_MECHANISM_FILE} exists at the base commit and the base was ` +
          'accepted, yet head’s copy supplied the verdict. The whole point of the base-ref load ' +
          'is that a PR editing the mechanism does not get to be judged by its own edit.',
      ).toBe(false)
    }
  })

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
        `executing ${observed.commandsRun.length} CI-wired check command(s)`,
    )
    console.log(
      `guard-denominator: ${observed.commandsSkipped.length} wired check(s) not executable by ` +
        `this harness: ${observed.commandsSkipped.map((c) => `${c.name} — ${c.reason}`).join('; ')}`,
    )

    const explain = (failing: string[]): string =>
      `${failing.length} guard(s) were run and printed no count, and are not in ` +
      `${DENOMINATOR_BASELINE_FILE}: ${failing.join(', ')}. This is #1363's closing condition: a ` +
      'new or modified guard cannot merge silently uncounted. Make the guard STATE how many ' +
      'things it examined when it passes — a line of real output carrying denominator ' +
      'vocabulary and a number, e.g. `audited 30 shell file(s) under scripts/` — reachable from ' +
      'its CI-wired `biffo check` command. Adding it to the baseline instead will NOT work: ' +
      'that file is ratcheted against the merge base and an addition fails the build.'

    expect(newlyFailing, explain(newlyFailing)).toEqual([])

    if (headObserved !== null) {
      const headFailing = headObserved.silent.filter((f) => !baseline.includes(f))
      expect(
        headFailing,
        `Head's edited copy of the mechanism disagrees with base's: ${explain(headFailing)} ` +
          'Base’s copy is what binds, but an edit to the mechanism must also pass under ' +
          'its own new rules — otherwise it lands unexercised and takes effect on dev after ' +
          'the merge, which is the "guard and authority are two revisions of one file" shape.',
      ).toEqual([])
    }
  })

  it('the baseline may only SHRINK — growing it inside this branch is itself the failure', () => {
    expect(rootOfTrustError).toBeNull()
    const baseCommit = (base as BaselineBase).commit

    const baseEntries = mechanism.readDenominatorBaselineAt(repoRoot, baseCommit)
    const ratchet = mechanism.denominatorRatchet(baseline, baseEntries)

    if (ratchet.establishing) {
      console.log(
        `guard-denominator: no baseline at ${baseCommit} — establishing one with ` +
          `${baseline.length} grandfathered guard(s). Every later branch is ratcheted against it.`,
      )
    } else {
      console.log(
        `guard-denominator: baseline ${baseline.length} entr(ies) vs ${baseEntries?.length ?? 0} ` +
          `at ${baseCommit}: ${ratchet.added.length} added, ${ratchet.removed.length} removed`,
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
        'that introduces it.',
    ).toEqual([])

    // The second condition, which binds even on the run that ESTABLISHES the
    // baseline (where the diff above is vacuously empty and would otherwise
    // let the attack through exactly once — on the change meant to stop it).
    const notPreExisting = mechanism.baselineEntriesAbsentAtBase(repoRoot, baseCommit, baseline)
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

  describe('the mechanism is loaded from the base ref, proved against real git', () => {
    /** A repo with `dev` and a topic branch that REWRITES the mechanism file,
     * which is the shape of every attack in round 2. */
    const makeRepo = (baseBody: string, headBody: string): { repo: string; devSha: string } => {
      const repo = makeTmpDir('denominator-mechanism')
      mkdirSync(join(repo, 'cli', 'src', 'lib'), { recursive: true })
      const g = (args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      g(['init', '-q', '-b', 'dev'])
      g(['config', 'user.email', 'test@example.com'])
      g(['config', 'user.name', 'Test'])
      const mech = join(repo, DENOMINATOR_MECHANISM_FILE)
      writeFileSync(mech, baseBody)
      g(['add', '-A'])
      g(['commit', '-q', '-m', 'base'])
      const devSha = g(['rev-parse', 'HEAD']).trim()
      g(['checkout', '-q', '-b', 'topic'])
      writeFileSync(mech, headBody)
      g(['commit', '-qam', 'weaken the mechanism'])
      return { repo, devSha }
    }

    it('extracts the BASE copy, not the working tree copy — the edit is simply not read', () => {
      const { repo, devSha } = makeRepo(
        'export const verdict = "strict"\n',
        'export const verdict = "anything goes"\n',
      )
      const dir = makeTmpDir('denominator-extract')
      const file = head.extractFileAtCommit(repo, devSha, DENOMINATOR_MECHANISM_FILE, dir)
      expect(file).not.toBeNull()
      expect(execFileSync('cat', [file as string], { encoding: 'utf8' })).toContain('strict')
      // Fail-first: the working tree really does carry the weakened copy, so
      // this is a difference the extraction chose, not an absence of one.
      expect(
        execFileSync('cat', [join(repo, DENOMINATOR_MECHANISM_FILE)], { encoding: 'utf8' }),
      ).toContain('anything goes')
    })

    it('returns null when the file does not exist at base — the establishing case, not agreement', () => {
      const { repo } = makeRepo('x\n', 'y\n')
      const dir = makeTmpDir('denominator-extract-absent')
      expect(head.extractFileAtCommit(repo, 'HEAD', 'cli/no-such-file.ts', dir)).toBeNull()
    })

    it('REJECTS a base commit the branch authored — the exact round-2 defeat', () => {
      const { repo, devSha } = makeRepo('a\n', 'b\n')
      const headSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()

      // What a rewritten resolver would return: this branch's own tip.
      expect(head.baseCommitIsContainedIn(repo, headSha, 'dev')).toBe(false)
      // What an honest resolver returns: a commit `dev` already carries.
      expect(head.baseCommitIsContainedIn(repo, devSha, 'dev')).toBe(true)
      // And the two really are different commits, so the assertion above is
      // not passing because the fixture collapsed them.
      expect(headSha).not.toBe(devSha)
    })

    it('the integration ref list is derived from the runner-set GITHUB_BASE_REF, and is checkable', () => {
      expect(head.integrationRefCandidates({ GITHUB_BASE_REF: 'dev' })).toEqual([
        'origin/dev',
        'dev',
      ])
      expect(head.integrationRefCandidates({ GITHUB_BASE_REF: 'staging' })).toEqual([
        'origin/staging',
        'origin/dev',
        'dev',
      ])
      expect(head.integrationRefCandidates({})).toEqual(['origin/dev', 'dev'])
      // A ref outside the list is what a rewritten resolver would need in
      // order to point the comparison at something it controls.
      expect(head.integrationRefCandidates({})).not.toContain('HEAD')
    })
  })

  describe('push vs pull_request: base==HEAD is expected on push, still rejected on pull_request (#1629)', () => {
    /** `dev` with one commit, then a second commit ON `dev` ITSELF — the shape
     * of a squash-merge PR landing: one new commit whose parent is the branch's
     * own previous tip. `origin/dev` is pointed at the same tip a real push
     * run's checkout would already see it at (the push already happened by the
     * time CI runs). No `topic` branch: a push-triggered run checks out `dev`
     * directly, HEAD IS `dev`. */
    const makePushLikeRepo = (): { repo: string; devSha: string; parentSha: string } => {
      const repo = makeTmpDir('denominator-push-fallback')
      const g = (args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      g(['init', '-q', '-b', 'dev'])
      g(['config', 'user.email', 'test@example.com'])
      g(['config', 'user.name', 'Test'])
      writeFileSync(join(repo, 'file.txt'), 'one\n')
      g(['add', '-A'])
      g(['commit', '-q', '-m', 'pre-existing dev history'])
      const parentSha = g(['rev-parse', 'HEAD']).trim()
      writeFileSync(join(repo, 'file.txt'), 'two\n')
      g(['commit', '-qam', 'squash-merged PR lands on dev'])
      const devSha = g(['rev-parse', 'HEAD']).trim()
      // What CI's fetch would already show: origin/dev == the just-pushed tip.
      g(['update-ref', 'refs/remotes/origin/dev', devSha])
      return { repo, devSha, parentSha }
    }

    it('1. PUSH run (GITHUB_BASE_REF unset, base==HEAD): first parent used, not rejected', () => {
      const { repo, devSha, parentSha } = makePushLikeRepo()
      expect(head.isPullRequestRun({})).toBe(false)

      const result = head.resolveBaselineBase(repo, {})
      expect(result).not.toBeNull()
      const b = result as BaselineBase
      // Fail-first evidence: the RAW merge-base really is HEAD here — this is
      // not a fixture where the substitution is vacuous.
      const rawMergeBase = execFileSync('git', ['-C', repo, 'merge-base', 'HEAD', 'origin/dev'], {
        encoding: 'utf8',
      }).trim()
      expect(rawMergeBase).toBe(devSha)
      // What the fixed resolver returns instead:
      expect(b.viaPushFirstParent).toBe(true)
      expect(b.commit).toBe(parentSha)
      expect(b.commit).not.toBe(devSha)
      // And the substituted commit is still a real, verifiable ancestor of
      // dev — the root-of-trust check downstream still has something to bind.
      expect(head.baseCommitIsContainedIn(repo, b.commit, b.ref)).toBe(true)
    })

    it('2. PULL_REQUEST run with a genuinely distinct base: passes exactly as today', () => {
      const repo = makeTmpDir('denominator-pr-legit')
      const g = (args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      g(['init', '-q', '-b', 'dev'])
      g(['config', 'user.email', 'test@example.com'])
      g(['config', 'user.name', 'Test'])
      writeFileSync(join(repo, 'file.txt'), 'one\n')
      g(['add', '-A'])
      g(['commit', '-q', '-m', 'dev tip'])
      const devSha = g(['rev-parse', 'HEAD']).trim()
      g(['update-ref', 'refs/remotes/origin/dev', devSha])
      g(['checkout', '-q', '-b', 'topic'])
      writeFileSync(join(repo, 'file.txt'), 'two\n')
      g(['commit', '-qam', 'PR work, not yet merged'])
      const topicSha = g(['rev-parse', 'HEAD']).trim()
      expect(topicSha).not.toBe(devSha)

      expect(head.isPullRequestRun({ GITHUB_BASE_REF: 'dev' })).toBe(true)
      const result = head.resolveBaselineBase(repo, { GITHUB_BASE_REF: 'dev' })
      expect(result).not.toBeNull()
      const b = result as BaselineBase
      expect(b.viaPushFirstParent).toBe(false)
      expect(b.commit).toBe(devSha)
      expect(b.commit).not.toBe(topicSha)
      expect(head.baseCommitIsContainedIn(repo, b.commit, b.ref)).toBe(true)
    })

    it('3. THE ATTACK: pull_request run where base resolves to HEAD — still REJECTED, no fallback', () => {
      const { repo, devSha } = makePushLikeRepo()
      // Checked out AT dev's own tip (HEAD === devSha) with GITHUB_BASE_REF
      // set — the exact round-2 shape: a base resolution that coincides with
      // the branch's own HEAD, this time under pull_request semantics where
      // that coincidence is never innocent.
      expect(head.isPullRequestRun({ GITHUB_BASE_REF: 'dev' })).toBe(true)

      const result = head.resolveBaselineBase(repo, { GITHUB_BASE_REF: 'dev' })
      expect(result).not.toBeNull()
      const b = result as BaselineBase
      // The load-bearing assertion: pull_request mode never substitutes, so
      // the caller's "must not be HEAD" check still has base===HEAD to reject.
      expect(b.viaPushFirstParent).toBe(false)
      expect(b.commit).toBe(devSha)
      const headCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
      expect(b.commit).toBe(headCommit)
      // This is precisely the condition guard-denominator.test.ts's own
      // beforeAll rejects on: `headSha !== null && base.commit === headSha`.
    })
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

    it('a digit inside a PATH does not manufacture a count — the verdict must not depend on cwd', () => {
      // Found by the attack rig, not reasoned about: under `\b\d+\b` this
      // exact line was credited, because `\b` matches between `-` and `1` and
      // `claude-1000` supplied `1000`. `plugin-allowlist-convention` states no
      // count and is baselined for it, yet it silently left the baseline
      // whenever the checkout sat under a numbered path — so the number of
      // credited guards was a function of the working directory.
      expect(
        outputStatesADenominator(
          'audited the plugin-allowlist naming convention under /tmp/claude-1000/x/repo\n',
        ),
      ).toBe(false)
      expect(outputStatesADenominator('scanned files under /home/build-2/app\n')).toBe(false)
      // …while a real count sitting beside such a path is still a count.
      expect(
        outputStatesADenominator('audited 30 shell file(s) under /tmp/claude-1000/x/repo\n'),
      ).toBe(true)
    })

    it('a count is credited whichever side of the vocabulary word it falls', () => {
      // `[coverage] <scanner>: N path(s) reached` (#1454) is the shape that
      // motivated not requiring adjacency.
      expect(outputStatesADenominator('[coverage] terraform-input: 12 path(s) reached\n')).toBe(
        true,
      )
      expect(outputStatesADenominator('reached 12 path(s)\n')).toBe(true)
    })

    it('a HARDCODED count still satisfies this gate — an open hole, recorded not hidden', () => {
      // Runtime observation cannot distinguish a computed number from a typed
      // one; at the point the bytes leave the process they are the same bytes.
      // The static detector this replaced required an interpolation and would
      // have rejected it, so the two have mirror-image blind spots. Asserted
      // rather than described so the day it stops being true, this fails and
      // somebody updates the docstring that claims it.
      expect(outputStatesADenominator('examined 25 item(s)\n')).toBe(true)
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

      const baseEntries = head.readDenominatorBaselineAt(repo, 'dev', REL)
      const working = head.readDenominatorBaselineAt(repo, 'topic', REL)
      const ratchet = head.denominatorRatchet(working as string[], baseEntries)

      expect(ratchet.added).toEqual(['fake-thing-guard.ts'])
      expect(ratchet.establishing).toBe(false)
    })

    it('PASSES when the branch only removes entries', () => {
      const repo = makeRepo()
      write(repo, [])
      execFileSync('git', ['-C', repo, 'commit', '-qam', 'guard now prints; unbaseline it'], {
        stdio: 'ignore',
      })

      const ratchet = head.denominatorRatchet(
        head.readDenominatorBaselineAt(repo, 'topic', REL) as string[],
        head.readDenominatorBaselineAt(repo, 'dev', REL),
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

      const entries = head.readDenominatorBaselineAt(repo, 'topic', REL) as string[]
      expect(head.baselineEntriesAbsentAtBase(repo, 'dev', entries, 'guards')).toEqual([
        'fake-thing-guard.ts',
      ])
      // …and the pre-existing entry is untouched, so day-one debt never blocks.
      expect(head.baselineEntriesAbsentAtBase(repo, 'dev', ['legacy-guard.ts'], 'guards')).toEqual(
        [],
      )
    })

    it('an absent baseline at the base commit is "establishing", not an empty comparison', () => {
      // The distinction that keeps the first introduction of the file from
      // reading as "everything was added", and keeps a missing file from
      // silently permitting anything afterwards.
      const repo = makeRepo()
      expect(head.readDenominatorBaselineAt(repo, 'dev', 'no-such-file.json')).toBeNull()
      expect(head.denominatorRatchet(['a.ts'], null)).toEqual({
        added: [],
        removed: [],
        establishing: true,
      })
    })

    it('a malformed baseline throws rather than degrading to an empty set', () => {
      const repo = makeRepo()
      writeFileSync(join(repo, REL), '{"noDenominator": "not-an-array"}\n')
      execFileSync('git', ['-C', repo, 'commit', '-qam', 'break it'], { stdio: 'ignore' })
      expect(() => head.readDenominatorBaselineAt(repo, 'topic', REL)).toThrow(/invalid/)
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
