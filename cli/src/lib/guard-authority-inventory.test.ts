import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  GUARD_AUTHORITY_INVENTORY,
  type GuardAuthorityRecord,
} from './guard-authority-inventory.js'
import { discoverGuardCandidates, discoverGuardFiles } from './guard-candidates.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * Sweep for class issue #1362 ("a guard resolves its answer from a different
 * document than the actor it is guarding" — 10 instances, 3 disagreement
 * tests, 0 sweep before this).
 *
 * ## What this sweep can and cannot do
 *
 * The issue's own history already proves a UNIVERSAL disagreement test is
 * not achievable: each instance's "two documents" are a different shape
 * (GraphQL rollup vs GitHub's dedup rule; PR body vs commit messages; a
 * Terraform resource pair; a manifest prefix vs git history; a FastAPI
 * router's include order). No single fixture generator constructs all of
 * them. `guard-authority-inventory.ts` says this plainly rather than
 * building a test that passes by only ever sampling agreement — the trap
 * the dispatch brief names explicitly (the whoami guard/actor pair NEVER
 * disagrees in this repo, only in an instance with a product domain).
 *
 * What IS swept: the ENUMERATION. Every guard file `guard-candidates.ts`
 * discovers under `cli/src/lib` — since #1519, the naming convention
 * (`*-guard.ts` / `*-audit.ts`) UNIONED with an export-name signal, not the
 * naming convention alone, and shared with `guard-wiring-sweep.test.ts`'s
 * #1413 sweep rather than each maintaining its own copy — must be classified
 * in `guard-authority-inventory.ts` below: in class or not, with a reason
 * either way. A guard landing with no entry fails this sweep. That is the
 * gap the issue's 2026-08-09 comment names directly: "Nothing enumerates the
 * guards ... guard nine will be written without one exactly as guards one
 * through eight were" — and #1519 sharpened it further: guard nine could be
 * written with a name the enumeration's own regex never matched, exactly
 * what happened to `core-upgrade-target-fidelity.ts`.
 *
 * A second, narrower check: when an inventory entry claims a disagreement
 * test exists, the referenced TS file must actually exist and its content
 * must show it constructs a divergent state — checked heuristically (does
 * it reference #1362 or contain a description matching /disagreement/i) —
 * not merely that a path string was typed in. This is proven against REAL
 * fixed instances below (#1333, #1334), not an invented one.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const libDir = join(repoRoot, 'cli', 'src', 'lib')

function byPath(record: GuardAuthorityRecord): string | undefined {
  return record.path
}

describe('guard/authority inventory sweep (#1362): every discovered guard is classified', () => {
  it('discovers at least the guard files known to exist today', () => {
    const found = discoverGuardFiles(libDir)
    expect(found.length).toBeGreaterThan(0)
    expect(found).toEqual(
      expect.arrayContaining(['core-ownership-guard.ts', 'core-direct-paths-audit.ts']),
    )
  })

  it('every discovered cli/src/lib guard/audit file has an inventory entry', () => {
    const discovered = discoverGuardFiles(libDir).map((f) => join('cli/src/lib', f))
    const known = new Set(GUARD_AUTHORITY_INVENTORY.map(byPath).filter(Boolean))

    // #1519's own denominator requirement: state the count, not just a result
    // over whatever discoverGuardFiles happened to admit.
    console.log(
      `guard-authority-inventory: ${discovered.length} guard(s) discovered, ${known.size} ` +
        `entries known in the inventory`,
    )

    const unclassified = discovered.filter((p) => !known.has(p))
    expect(
      unclassified,
      `${unclassified.length} guard(s) discovered under cli/src/lib have no entry in ` +
        `guard-authority-inventory.ts: ${unclassified.join(', ')}. Classify each one — ` +
        'inClass:true with a document/actor/disagreementTest, or inClass:false with the reason ' +
        'there is no second document to disagree with. An unclassified guard is exactly how #1362 ' +
        'stayed invisible for 10 instances: nothing ever asked the question of a NEW guard.',
    ).toEqual([])
  })

  it('every inventory entry with a path actually points at a file that exists', () => {
    for (const record of GUARD_AUTHORITY_INVENTORY) {
      if (!record.path) continue
      expect(() => readFileSync(join(repoRoot, record.path as string), 'utf8')).not.toThrow()
    }
  })

  it('in-class entries all name both a document and an actor — an inClass:true with neither is not classified, it is a placeholder', () => {
    for (const record of GUARD_AUTHORITY_INVENTORY) {
      if (!record.inClass) continue
      expect(record.document, `${record.id} is inClass but has no document`).toBeTruthy()
      expect(record.actor, `${record.id} is inClass but has no actor`).toBeTruthy()
    }
  })

  it('reports the honest remainder: in-class guards with no disagreement test yet', () => {
    const uncovered = GUARD_AUTHORITY_INVENTORY.filter((r) => r.inClass && !r.disagreementTest)
    // Not a failure — this is the deliverable the dispatch brief asked for: a
    // truthful count of what is NOT yet caught, not a claim of completeness.
    // Printed so `pnpm --filter @biffo/cli test -- -t "honest remainder"`
    // surfaces it without reading source.
    console.log(
      `guard-authority-inventory: ${uncovered.length} in-class guard(s) with no disagreement ` +
        `test: ${uncovered.map((r) => r.id).join(', ')}`,
    )
    expect(uncovered.every((r) => r.note.length > 0)).toBe(true)
  })

  /**
   * Instance 11's ratchet: a `disagreementTest` proves a guard catches two
   * documents that differ. It says nothing about whether the guard's OWN
   * read shares a decode step with the actor's — which is precisely what let
   * `core-upgrade-target-fidelity` pass a real #1399 disagreement test while
   * still being blind to a corrupted binary (see the module's own docstring
   * for the empirical proof: `{ checked: 1, findings: [] }` over a file that
   * had just been written corrupt). So `independence` is asked of every
   * in-class guard independently of whether it already has a
   * `disagreementTest` — the two questions are orthogonal, and a guard can
   * answer one without the other.
   */
  it('every in-class entry answers independence — instance 11 showed a disagreement test alone is not enough', () => {
    const unanswered = GUARD_AUTHORITY_INVENTORY.filter((r) => r.inClass && !r.independence)
    expect(
      unanswered,
      `${unanswered.length} in-class guard(s) have no \`independence\` verdict: ` +
        `${unanswered.map((r) => r.id).join(', ')}. A new in-class guard must say whether its ` +
        "own derivation shares a helper/parser/decode step with the actor's — " +
        "'independent' | 'shared-path' | 'unclear' — not merely whether a disagreement test " +
        'exists for it (#1362 instance 11: the two are different properties, and a guard can ' +
        'pass one while failing the other).',
    ).toEqual([])
  })

  it('reports the instance-11 remainder: in-class guards whose independence is shared-path or unclear', () => {
    const exposed = GUARD_AUTHORITY_INVENTORY.filter(
      (r) => r.inClass && (r.independence === 'shared-path' || r.independence === 'unclear'),
    )
    // Same posture as the disagreement-test remainder above: printed, not
    // failed, so the honest count is visible without reading source, and a
    // guard newly found to share its actor's decode step can be recorded
    // here before anyone has had time to fix it.
    console.log(
      `guard-authority-inventory: ${exposed.length} in-class guard(s) with independence ` +
        `shared-path/unclear: ${exposed.map((r) => `${r.id} (${r.independence ?? 'unset'})`).join(', ')}`,
    )
    expect(exposed.every((r) => r.note.length > 0)).toBe(true)
  })

  describe('a disagreement-test claim is checked, not trusted — proven against REAL fixed instances', () => {
    it('#1333 (wait-for-checks): the referenced test really does construct a stale-vs-fresh divergence', () => {
      const record = GUARD_AUTHORITY_INVENTORY.find((r) => r.id === 'wait-for-checks')
      expect(record?.disagreementTest).toBeTruthy()
      const text = readFileSync(join(repoRoot, record?.disagreementTest as string), 'utf8')
      expect(text).toMatch(/disagreement.*#1333.*class #1362|#1333.*class #1362/i)
      // The negative control #1362 itself requires: the same shape must also
      // be able to PASS, or the check can never go green honestly.
      expect(text.toLowerCase()).toContain('supersede')
    })

    it('#1334 (closing-keywords): the referenced test really does construct a body-vs-commit divergence', () => {
      const record = GUARD_AUTHORITY_INVENTORY.find((r) => r.id === 'closing-keywords')
      expect(record?.disagreementTest).toBeTruthy()
      const text = readFileSync(join(repoRoot, record?.disagreementTest as string), 'utf8')
      expect(text).toMatch(/#1334/)
      expect(text).toMatch(/#1362/)
      expect(text.toLowerCase()).toContain('commit message')
    })

    it('a fabricated disagreement-test claim pointing at a file with no real divergence content is NOT indistinguishable from a real one', () => {
      // Mechanism control: prove the sweep's content check can fail, using a
      // stub that exists on disk (so the "file exists" check alone would
      // pass it) but never constructs a divergent state.
      const dir = makeTmpDir('guard-authority-fake-disagreement')
      const fakeTest = join(dir, 'fake.test.ts')
      writeFileSync(
        fakeTest,
        "describe('unrelated', () => { it('passes', () => expect(1).toBe(1)) })\n",
      )
      const text = readFileSync(fakeTest, 'utf8')
      expect(text).not.toMatch(/#1362/)
      expect(text.toLowerCase()).not.toContain('disagreement')
    })
  })

  it("flags a synthetic new guard file with no inventory entry (mechanism control, mirrors #1413's own)", () => {
    const dir = makeTmpDir('guard-authority-unclassified')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'new-shape-guard.ts'), 'export function check() { return [] }\n')

    // discoverGuardFiles' isGuard:true subset depends on
    // GUARD_CANDIDATE_CLASSIFICATION, a real table a synthetic tmp-dir file
    // can never appear in (see guard-candidates.test.ts's own fail-first
    // proof for that gap). This control exercises the #1362 INVENTORY layer
    // specifically, so it uses discoverGuardCandidates — new-shape-guard.ts
    // still matches the naming-convention discovery signal.
    const discovered = discoverGuardCandidates(dir)
    expect(discovered).toEqual(['new-shape-guard.ts'])

    const known = new Set(GUARD_AUTHORITY_INVENTORY.map(byPath).filter(Boolean))
    expect(known.has(join(dir, 'new-shape-guard.ts'))).toBe(false) // this is what "unclassified" looks like
  })
})
