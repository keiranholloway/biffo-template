/**
 * The rehearsal must invoke the gate exactly as `.githooks/pre-push` does — and
 * on 2026-08-03 it silently stopped.
 *
 * `shared-sync.sh`'s rehearsal has always carried a comment asserting this
 * invariant, in as many words: *"`sh`, not `bash`: this is exactly how
 * `.githooks/pre-push` invokes it"*. Then #1241 moved `verify.sh` into the
 * versioned CLI package and swept the satellites' copies. `pre-push` was updated
 * to `exec sh scripts/biffo.sh verify`; the two call sites in `shared-sync.sh`
 * were not.
 *
 * From 19:25 that evening every rehearsal target failed with
 * `sh: 0: cannot open scripts/verify.sh: No such file` — and because the
 * rehearsal deliberately refuses the whole round when any target fails,
 * **shared-file distribution was down estate-wide** from that moment. Nothing
 * reported it, because nothing ran a round on a schedule. It surfaced on the
 * first round attempted afterwards, by which point all 14 satellites were
 * drifted on `.githooks/pre-push` and `AGENTS.md` — including the
 * claim-collision gate added the day before, which reached zero of them.
 *
 * A comment asserting an invariant is not a guard on it. This is.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SYNC = readFileSync(join(repoRoot, 'scripts/shared-sync.sh'), 'utf8')
const PRE_PUSH = readFileSync(join(repoRoot, '.githooks/pre-push'), 'utf8')

/** How pre-push actually runs the gate, e.g. `sh scripts/biffo.sh verify`. */
function prePushGateInvocation(): string {
  const m = PRE_PUSH.match(/^exec (sh .+)$/m)
  if (!m) throw new Error('no `exec sh ...` gate invocation found in .githooks/pre-push')
  return m[1].trim()
}

describe('the rehearsal runs the same gate the push hook runs', () => {
  it('invokes the gate exactly as .githooks/pre-push does', () => {
    const invocation = prePushGateInvocation()
    // The rehearsal runs it inside the staged worktree, so the command appears
    // as `(cd "$wt" && <invocation> 2>&1)`.
    expect(SYNC).toContain(`(cd "$wt" && ${invocation} 2>&1)`)
  })

  it('discovers install directories through the same entrypoint', () => {
    const entry = prePushGateInvocation() // e.g. `sh scripts/biffo.sh verify`
    expect(SYNC).toContain(`(cd "$wt" && ${entry} --list 2>/dev/null)`)
  })

  /**
   * The specific regression. `scripts/verify.sh` does not exist in any satellite
   * since #1241, so any *executed* reference to it fails in every repo. Comments
   * and historical narrative keep the name deliberately — the file is still the
   * canonical source packaged into the CLI — so this reads code lines only.
   */
  it('never executes scripts/verify.sh directly, which no satellite holds', () => {
    const offenders = SYNC.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trim().startsWith('#'))
      .filter(({ line }) => /(?:^|[^-\w])(?:sh|bash|exec)\s+scripts\/verify\.sh/.test(line))
    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([])
  })

  /**
   * The scope clause is the quieter half of the same breakage. It tested for a
   * file the sweep had deleted, so it resolved only because four local working
   * trees still carried a stale copy — every one of them a checkout the audit
   * reports as parked or behind. A `git pull` in any of them would have dropped
   * the repo out of scope with no error, which is the #1145 shape: a check that
   * cannot evaluate an input drops it and reports the remainder as the whole.
   */
  it('scopes marker-less repos by a file the satellites actually hold', () => {
    const clause = SYNC.match(/^\s*\[ -f "\$1\/(scripts\/[a-z.-]+)" \] && return 0$/m)
    expect(clause, 'applies() must keep a scope clause for marker-less repos').not.toBeNull()
    const scopeFile = clause![1]

    // Whatever it tests for must be a path the mechanism actually distributes,
    // or the clause decays into "whatever is stale on this machine".
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'shared-files.json'), 'utf8'))
    expect(manifest.files).toContain(scopeFile)
  })

  /**
   * The regression #1290 shipped, and the reason the filename was never the
   * point. That PR swapped the scope clause from `scripts/verify.sh` to
   * `scripts/biffo.sh` and kept the `[ -f ... ]` working-tree test — so on the
   * next run all four marker-less repos left scope in silence, because their
   * checkouts are parked on `main` or behind and still hold the previous
   * generation's file. The round went from 14 repos to 10 with no error.
   *
   * A scope test against a working tree measures whoever last ran `git pull` on
   * the machine, not the estate. `shared-files.json`'s `mustBeUniform` note
   * records the same lesson from the other direction, in as many words: it reads
   * `origin/<base>` refs "never a working tree", because a guard that moves with
   * somebody's stale checkout is one people learn to ignore.
   *
   * The `[ -f ... ]` fallback is deliberate and stays — a clone with no fetched
   * origin genuinely cannot answer, and refusing scope there would be worse. The
   * invariant is that the REF is consulted first.
   */
  it('resolves scope from origin/<base>, not from whatever the checkout happens to hold', () => {
    const applies = SYNC.slice(
      SYNC.indexOf('applies() {'),
      SYNC.indexOf('\n}\n', SYNC.indexOf('applies() {')),
    )

    const refTest = applies.search(
      /git -C "\$1" rev-parse -q --verify "origin\/\$_base:scripts\/biffo\.sh"/,
    )
    const treeTest = applies.search(/^\s*\[ -f "\$1\/scripts\/biffo\.sh" \] && return 0$/m)

    expect(refTest, 'applies() must consult the origin ref for the scope clause').toBeGreaterThan(
      -1,
    )
    expect(
      treeTest,
      'the working-tree fallback should remain for unfetchable clones',
    ).toBeGreaterThan(-1)
    expect(refTest).toBeLessThan(treeTest)
  })
})
