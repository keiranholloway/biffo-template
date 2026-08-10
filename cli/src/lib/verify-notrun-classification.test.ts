/**
 * `scripts/verify.sh` has two buckets for a check that did not run, and the
 * difference is the whole defect class (#1464, biffo-template#1363):
 *
 *   - "not applicable here" (`skip()` -> `SKIPPED`) means there is nothing to
 *     act on -- no terraform files, no package.json, no such script.
 *   - "APPLICABLE BUT NOT RUN" (`NOT_RUN`) means CI checks this and the local
 *     gate did not, for some reason of its own (cost, a missing local tool, an
 *     explicit opt-out).
 *
 * A cost-skipped pytest was filed in the first bucket even though CI treats it
 * as a required check -- it read as "nothing to do here" beside a genuinely
 * inapplicable `build` line, which is how three CI-only failures in one day
 * went undetected locally (the issue's own worked example). `terraform-fmt`
 * and `gitleaks` had the identical bug for "tool not installed", unexposed
 * only because the auditing machine happened to have both tools.
 *
 * This test does not run `verify.sh` -- it reads the SOURCE, because the
 * defect is a wrong call site, not a wrong runtime value, and the property
 * needs to hold for every `skip(...)` call whether or not this machine can
 * exercise the branch that reaches it. Every `skip()` call whose own reason
 * text claims CI still runs the thing (a wording this file's own convention
 * uses -- "CI keeps it", "CI runs this", "CI checks this", "not installed")
 * is filed in the wrong bucket by definition: if CI runs it, the correct
 * bucket is `NOT_RUN`, not `SKIPPED`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const verifySh = readFileSync(join(repoRoot, 'scripts/verify.sh'), 'utf8')

/**
 * Matches a call to the `skip()` shell function -- `skip <name> "<reason>"`,
 * where `<name>` may or may not be quoted -- and captures the reason string.
 * Deliberately does not match the function's own `skip() { ... }` definition
 * (no `(` follows the name here) or `NOT_RUN=`/`SKIPPED=` assignments.
 */
const SKIP_CALL = /(?<!\w)skip\s+(?:"[^"]*"|\S+)\s+"((?:[^"\\]|\\.)*)"/g

/**
 * Phrasing that means "CI still checks this" -- the property under test is
 * that no `skip()` reason contains any of these, because a reason that says
 * so is, by the two buckets' own definition, describing NOT_RUN, not SKIPPED.
 * Case-insensitive; matched against the reason text only, not the whole line,
 * so a comment elsewhere in the file mentioning CI does not trip it.
 */
const CI_STILL_RUNS_THIS = /CI (?:keeps it|runs|checks|still runs)|not installed.*CI/i

function skipReasons(source: string): string[] {
  const reasons: string[] = []
  for (const m of source.matchAll(SKIP_CALL)) {
    reasons.push(m[1])
  }
  return reasons
}

describe('verify.sh: every skip() reason is genuinely "not applicable"', () => {
  const reasons = skipReasons(verifySh)

  it('finds a non-trivial number of skip() call sites (sanity check on the regex)', () => {
    // Pinned to the current count so a change to the extraction regex itself
    // is visible here rather than silently matching zero and passing empty.
    // Lower this only if a skip() call site is genuinely removed; raise it if
    // one is genuinely added.
    expect(reasons.length).toBeGreaterThanOrEqual(9)
  })

  it.each(reasons.map((r) => [r] as const))(
    'reason %j does not claim CI still checks the skipped thing',
    (reason) => {
      expect(reason).not.toMatch(CI_STILL_RUNS_THIS)
    },
  )

  it('the pytest cost-skip is filed as NOT_RUN, not SKIPPED (#1464)', () => {
    // The reported instance, pinned directly rather than only via the general
    // sweep above: a future refactor that renames the reason string out from
    // under CI_STILL_RUNS_THIS's pattern would otherwise go undetected.
    expect(verifySh).toMatch(/NOT_RUN="\$NOT_RUN pytest\$suffix"/)
    expect(verifySh).not.toMatch(
      /skip\s+"pytest\$suffix"\s+"suite is slower than \$\{PYTEST_BUDGET_SECONDS\}s - CI keeps it"/,
    )
  })
})
