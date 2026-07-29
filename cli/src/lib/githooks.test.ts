import { describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The hooks must be present and runnable in a *worktree*, with no install step.
 *
 * ## The bug this exists to prevent (#838)
 *
 * `core.hooksPath` was `.husky/_` — a **relative** path, which git resolves
 * against each worktree's own root. Only `.husky/pre-commit`, `pre-push` and
 * `commit-msg` were tracked; `.husky/_/`, the directory git actually executes,
 * is gitignored and created **solely** by `prepare: husky` on `pnpm install`.
 *
 * So every fresh worktree had no `.husky/_`, and git skipped every hook — with
 * no warning, no error, and no output. Verified on
 * `tabsii-platform/.worktrees/discovery-rls`: the three tracked hook files
 * present, `.husky/_` absent, and therefore no pyright, no lint-staged and no
 * commitlint on anything committed there. Every PR built by the documented
 * worktree workflow shipped unguarded, and the guards looked fine in the tree.
 *
 * AGENTS.md §1 mandates a fresh worktree per unit of work, so the workflow the
 * project requires was the workflow that disarmed its own gates.
 *
 * The fix is that the hooks are tracked files. A tracked file exists the instant
 * `git worktree add` completes. These assertions are what keep them that way —
 * an untracked or non-executable hook is indistinguishable from a working one
 * until the day it matters.
 */
const repoRoot = join(import.meta.dirname, '..', '..', '..')
const HOOKS = ['pre-commit', 'pre-push', 'commit-msg']

describe('git hooks are armed without an install step', () => {
  it.each(HOOKS)('.githooks/%s is executable', (hook) => {
    const mode = statSync(join(repoRoot, '.githooks', hook)).mode
    // git runs hooksPath entries directly, not through a shell wrapper, so a
    // hook without the executable bit is silently not run.
    expect(mode & 0o111, `.githooks/${hook} must be executable`).toBeGreaterThan(0)
  })

  it.each(HOOKS)('.githooks/%s has a shebang', (hook) => {
    const body = readFileSync(join(repoRoot, '.githooks', hook), 'utf8')
    // Executed directly rather than sourced by husky, so it needs its own
    // interpreter line.
    expect(body.startsWith('#!')).toBe(true)
  })

  it('points core.hooksPath at the tracked directory on install', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    expect(pkg.scripts.prepare).toContain('core.hooksPath .githooks')
    // husky's `prepare` is what created the gitignored runner directory. If it
    // comes back, so does the bug.
    expect(pkg.scripts.prepare).not.toContain('husky')
    expect(pkg.devDependencies?.husky).toBeUndefined()
  })

  it.each(HOOKS)('.husky/%s forwards to the tracked hook rather than duplicating it', (hook) => {
    // Kept for clones whose core.hooksPath still says `.husky/_`. They must run
    // the same logic, not a stale copy of it — and deleting them outright would
    // disarm those clones silently, which is the failure being fixed.
    const body = readFileSync(join(repoRoot, '.husky', hook), 'utf8')
    expect(body).toContain(`.githooks/${hook}`)
    expect(body).toContain('exec sh')
  })

  it('runs the verify gate from pre-push, not a single check', () => {
    const body = readFileSync(join(repoRoot, '.githooks/pre-push'), 'utf8')
    expect(body).toContain('scripts/verify.sh')
    // Still skipped in CI: CI jobs that push have no `uv` on PATH, and a
    // pre-push firing there once blocked releases with `uv: not found`.
    expect(body).toContain('$CI')
  })
})
