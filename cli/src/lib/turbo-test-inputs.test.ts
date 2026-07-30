import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every repo-root file a test reads must be a declared input of the turbo task
 * that runs it (#923).
 *
 * ## The incident
 *
 * `cli/src/lib/practices-metrics.test.ts` reads `docs/practices/evidence.jsonl`
 * and `docs/guides/development-practices.md` at runtime. Both live **outside**
 * the `cli` package, and the `test` task declared `inputs: ["$TURBO_DEFAULT$",
 * ".env.test*"]` — the package's own files. So changing the corpus did not change
 * the cache key: turbo correctly concluded nothing about `@biffo/cli` had changed
 * and **replayed a stale pass**.
 *
 * Reproduced on 2026-07-30 with a corpus row the derived tables did not account
 * for — a state CI rejects:
 *
 * ```
 * @biffo/cli:test: cache hit, replaying logs b22e2f9f7a636b57
 * GATE VERDICT: verify PASSED
 * ```
 *
 * `scripts/verify.sh` therefore printed `verify passed` on a change it never
 * tested, and the same change failed three tests in CI minutes later. That is the
 * fail-open shape the practices programme exists to remove, in the gate built to
 * remove it — and H4's central argument ("if `pnpm run test` fails on a runner, it
 * fails locally") holds only while the local run actually executes.
 *
 * ## Why this guard rather than only the two paths
 *
 * Adding the two files to `turbo.json` fixes the instance. It does not stop the
 * next out-of-package fixture reopening the hole, silently, with the same
 * signature — a green gate and a red CI. This estate keeps recording fixes
 * written for one caller instead of the class; this is the class.
 *
 * The guard is deliberately syntactic: it greps the test sources for the
 * `readRepo('…')` idiom rather than executing them, so it cannot itself be
 * defeated by a cache.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const TURBO = JSON.parse(readFileSync(join(REPO_ROOT, 'turbo.json'), 'utf8'))

/** Recursively collect `*.test.ts` under a directory. */
function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...testFiles(full))
    else if (entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/**
 * Repo-root paths read via the `readRepo('<path>')` helper.
 *
 * Matching the helper name rather than `readFileSync` is deliberate: a test
 * reading a file inside its own package is already covered by `$TURBO_DEFAULT$`,
 * and flagging those would make this guard noisy enough to be switched off.
 */
function repoRootReads(): string[] {
  const found = new Set<string>()
  for (const file of testFiles(join(REPO_ROOT, 'cli', 'src'))) {
    // Skip this file. It *describes* the idiom in prose, so its own docstring
    // examples — `readRepo('<path>')` — are matched as if they were real reads.
    // Caught by the guard failing on its own comments the first time it ran.
    if (file.endsWith('turbo-test-inputs.test.ts')) continue
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/readRepo\(\s*['"]([^'"]+)['"]\s*\)/g)) found.add(m[1])
  }
  return [...found]
}

describe('turbo test inputs cover every repo-root file the tests read', () => {
  it('finds the reads at all — a guard over an empty set passes vacuously', () => {
    // The negative control. If the `readRepo` idiom is renamed, this fails loudly
    // instead of the suite below going quietly green over nothing.
    expect(repoRootReads().length).toBeGreaterThan(0)
  })

  it('declares each of them as an input of the test task', () => {
    const inputs: string[] = TURBO.tasks.test.inputs
    const missing = repoRootReads().filter(
      (p) => !inputs.some((i) => i === `$TURBO_ROOT$/${p}` || i === p),
    )
    expect(missing, `not declared in turbo.json tasks.test.inputs: ${missing.join(', ')}`).toEqual(
      [],
    )
  })

  it('keeps $TURBO_DEFAULT$, so declaring one file does not narrow the rest', () => {
    // Turbo replaces the default set when `inputs` is given. Dropping the token
    // while adding a path would stop the package's own sources invalidating the
    // cache — a far worse version of the bug being fixed.
    expect(TURBO.tasks.test.inputs).toContain('$TURBO_DEFAULT$')
  })
})
