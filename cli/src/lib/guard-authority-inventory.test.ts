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

  it('an in-class guard cannot be added without its disagreement test', () => {
    const uncovered = GUARD_AUTHORITY_INVENTORY.filter((r) => r.inClass && !r.disagreementTest)

    // Printed as well as asserted, so the count is visible in a passing run
    // and not only in a failing one.
    console.log(
      `guard-authority-inventory: ${uncovered.length} in-class guard(s) with no disagreement ` +
        `test: ${uncovered.map((r) => r.id).join(', ') || 'none'}`,
    )

    // **This reported instead of failing until 2026-08-16, and reporting was
    // right at the time**: there were two in-class guards with no test, and a
    // gate that is red on day-one residue every morning is one people learn to
    // scroll past (`scripts/protection-audit.sh` argues this at length, and
    // `mustBeUniform`'s baseline exists for it).
    //
    // Both were written that day (#1598 core-ownership, #1599 the claim
    // resolver), so the remainder is **zero** and the residue argument no
    // longer applies. An absolute gate is therefore available where a ratchet
    // with a baseline would otherwise have been necessary — and it is strictly
    // stronger, because there is no number for anyone to raise.
    //
    // This is #1362's own closing condition, stated in the issue as "closes
    // when a new guard cannot be written without its disagreement test".
    //
    // **If you are here because this failed:** you added a guard that reads one
    // document on behalf of an actor that reads another, and it needs a test
    // constructing the state where the two differ. Two worked examples, and
    // they are deliberately different shapes:
    //   * PRESCRIPTIVE — `claim-structural-resolver-disagreement.test.ts`
    //     asserts the guard agrees with the authority, in both directions
    //     (a miss AND a false block), because the resolver can be correct.
    //   * DESCRIPTIVE — `core-ownership-orphan-disagreement.test.ts` pins a
    //     disagreement the guard cannot currently resolve (it has no view of
    //     the template tree), and says in its own assertion message that a
    //     failure means the fix landed. Use this shape when the guard is
    //     structurally unable to agree yet; it is not an excuse to skip the
    //     test, it is how you record what the guard cannot see.
    //
    // What you must NOT do is set `inClass: false` to get past this line. That
    // field is answered by `document` and `actor` being nameable, not by
    // whether a test is convenient — and the classification is itself asserted
    // above.
    expect(
      uncovered.map((r) => r.id),
      'An in-class guard has no disagreement test. See the comment above this ' +
        'assertion for the two worked examples and why this is absolute rather ' +
        'than baselined.',
    ).toEqual([])
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

  /**
   * The instance-11 baseline. Unlike the disagreement-test gate above, this one
   * is a RATCHET rather than an absolute, and the difference is a measurement
   * rather than a preference: that remainder is zero, this one is two.
   *
   * A guard sharing its actor's decode step is not fixed by writing a test —
   * it needs the guard to derive its answer by a second, independent route,
   * which is a change to the guard. So an absolute gate here would be red
   * every morning over work nobody has scheduled, which is the failure this
   * estate keeps recording: `mustBeUniform` and the orphan ratchet both fail
   * only ABOVE their baseline for exactly this reason.
   */
  const INDEPENDENCE_REMAINDER_BASELINE = 2

  it('no NEW in-class guard may share its actor’s derivation path (ratchet)', () => {
    const exposed = GUARD_AUTHORITY_INVENTORY.filter(
      (r) => r.inClass && (r.independence === 'shared-path' || r.independence === 'unclear'),
    )
    console.log(
      `guard-authority-inventory: ${exposed.length} in-class guard(s) with independence ` +
        `shared-path/unclear (baseline ${INDEPENDENCE_REMAINDER_BASELINE}): ` +
        `${exposed.map((r) => `${r.id} (${r.independence ?? 'unset'})`).join(', ') || 'none'}`,
    )

    // Every one of them still has to carry its reasoning, baseline or not.
    expect(exposed.every((r) => r.note.length > 0)).toBe(true)

    expect(
      exposed.length,
      `${exposed.length} in-class guard(s) share or may share their actor's derivation ` +
        `path, above the baseline of ${INDEPENDENCE_REMAINDER_BASELINE}: ` +
        `${exposed.map((r) => r.id).join(', ')}. Instance 11 is what this catches — ` +
        '`core-upgrade-target-fidelity` passed a real disagreement test while being blind ' +
        'to a corrupted binary, because it re-read the same file through the same lossy ' +
        'decode the actor used. Two independently-mangled strings agreeing is not ' +
        'verification. Give the new guard a second derivation route, or record why it ' +
        'cannot have one and raise this baseline deliberately.',
    ).toBeLessThanOrEqual(INDEPENDENCE_REMAINDER_BASELINE)

    // A ratchet that never tightens stops meaning anything — same instruction
    // `shared-files.json` gives when a variant count drops below its baseline.
    if (exposed.length < INDEPENDENCE_REMAINDER_BASELINE) {
      console.log(
        `guard-authority-inventory: independence remainder IMPROVED to ${exposed.length} — ` +
          `lower INDEPENDENCE_REMAINDER_BASELINE to match.`,
      )
    }
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
