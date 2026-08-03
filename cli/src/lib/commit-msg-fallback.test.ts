import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * `.githooks/commit-msg` must validate a subject in EVERY repo, including the
 * ones where commitlint cannot run.
 *
 * ## Why
 *
 * The hook used to print `no commitlint config — subject not checked` and exit
 * 0. It looked for a root commitlint config and ran it via `pnpm exec`, which
 * needs a root `package.json`; most satellites have neither, because their
 * frontend is its own pnpm workspace under `apps/frontend/`. So the hook
 * abstained in **13 of 17 estate repos** (#1193) while printing a calm sentence
 * that reads like the hook working — AGENTS.md §3 binding everywhere and
 * enforced in three places.
 *
 * That is the #855 shape one layer down: a gate that runs, prints, and inspects
 * nothing.
 *
 * ## What is asserted here
 *
 * 1. The fallback's type list has not drifted from `commitlint.config.js`'s
 *    `type-enum`. The hook cannot import the config (it must run with no
 *    toolchain at all), so the list is duplicated — and a duplicated decision
 *    needs a guard or it becomes two decisions.
 * 2. The hook actually refuses a bad subject in a repo shaped like a satellite:
 *    no root `package.json`, no commitlint config. Driven through real `git
 *    commit`, because the failure being fixed was the hook taking the wrong
 *    branch — which only a real invocation can show.
 */

// cli/src/lib/ -> cli/src/ -> cli/ -> repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const hookPath = join(repoRoot, '.githooks/commit-msg')

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** A repo shaped like a satellite: hooks installed, no root package.json, no commitlint. */
function satelliteRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biffo-commitmsg-'))
  temps.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q', '-b', 'dev')
  git('config', 'user.email', 't@e.com')
  git('config', 'user.name', 'T')
  git('config', 'core.hooksPath', '.githooks')
  execFileSync('mkdir', ['-p', join(dir, '.githooks')])
  writeFileSync(join(dir, '.githooks/commit-msg'), readFileSync(hookPath, 'utf8'), { mode: 0o755 })
  writeFileSync(join(dir, 'a.txt'), 'x\n')
  git('add', '-A')
  return dir
}

function commit(dir: string, subject: string): { code: number; output: string } {
  try {
    execFileSync('git', ['commit', '-m', subject], { cwd: dir, stdio: 'pipe' })
    return { code: 0, output: '' }
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer }
    return {
      code: e.status ?? 1,
      output: `${String(e.stderr ?? '')}${String(e.stdout ?? '')}`,
    }
  }
}

describe('commit-msg fallback', () => {
  it('mirrors commitlint.config.js type-enum exactly', () => {
    const config = readFileSync(join(repoRoot, 'commitlint.config.js'), 'utf8')
    const enumMatch = /'type-enum':\s*\[\s*\d+,\s*'always',\s*\[([^\]]*)\]/.exec(config)
    expect(enumMatch, 'could not find type-enum in commitlint.config.js — has it moved?').not.toBe(
      null,
    )
    const authoritative = [...(enumMatch?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])

    const hook = readFileSync(hookPath, 'utf8')
    const hookMatch = /^BIFFO_COMMIT_TYPES='([^']*)'/m.exec(hook)
    expect(hookMatch, 'BIFFO_COMMIT_TYPES not found in .githooks/commit-msg').not.toBe(null)
    const mirrored = (hookMatch?.[1] ?? '').split(/\s+/).filter(Boolean)

    expect(
      authoritative.length,
      'parsed an empty type list — the regex has gone stale',
    ).toBeGreaterThan(5)
    expect(
      [...mirrored].sort(),
      'the hook’s fallback type list has drifted from commitlint.config.js',
    ).toEqual([...authoritative].sort())
  })

  it('refuses an unconventional subject where commitlint cannot run', () => {
    const dir = satelliteRepo()
    const { code, output } = commit(dir, 'add a thing')

    expect(code, 'the hook allowed an unconventional subject — it abstained').not.toBe(0)
    expect(output).toMatch(/no ": " separator|unknown type/)
    // The whole point: it must not announce that it skipped the check.
    expect(output).not.toMatch(/subject not checked/)
  })

  it('refuses an unknown type, and names it', () => {
    const { code, output } = commit(satelliteRepo(), 'wibble(api): something')
    expect(code).not.toBe(0)
    expect(output).toContain('unknown type "wibble"')
  })

  it('accepts a valid subject, including scope and breaking-change forms', () => {
    for (const subject of ['feat(api): add an endpoint', 'fix: a thing', 'feat(api)!: breaking']) {
      const { code, output } = commit(satelliteRepo(), subject)
      expect(code, `rejected a valid subject ${subject}: ${output}`).toBe(0)
    }
  })

  it("does not block git's own merge and rebase subjects", () => {
    // commitlint ignores these by default; a fallback that did not would break
    // ordinary git operations that the real tool permits.
    for (const subject of ['Merge branch "dev"', 'Revert "feat: x"', 'fixup! feat: x']) {
      const { code, output } = commit(satelliteRepo(), subject)
      expect(code, `blocked ${subject}: ${output}`).toBe(0)
    }
  })
})
