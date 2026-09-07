import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `has_python` (shared-files.json's `requiresPython`, #1958) must never
 * report "no Python" just because the `git` command it reads through failed
 * for some OTHER reason.
 *
 * The original implementation was `git ls-tree ... | grep -q ...` -- a
 * pipeline, so the function's own exit status was grep's, not git's, the
 * exact `cmd | tail` trap AGENTS.md's "Checking exit status through a pipe"
 * section names. A `git ls-tree` that fails for any reason (a transient lock,
 * a resource hiccup, a bad ref) hands grep an EMPTY stdin, grep correctly
 * reports no match on nothing, and the function said "no python" --
 * indistinguishable from a real Python-less repo. That silently skips a real
 * Python-only guard script (`scripts/error_branch_coverage.py`) for a repo
 * that actually has Python, which is the expensive direction to get wrong:
 * the opposite mistake (briefly delivering dead content to a repo with no
 * Python) self-corrects on the very next round.
 *
 * This extracts `has_python` alone, the same way
 * `shared-sync-ship-guard.test.ts` extracts `require_staged_worktree` --
 * the failing path is not reachable through a healthy end-to-end fixture by
 * construction, so driving the whole script would mean faking a `git`
 * failure well enough that the test asserts against a fiction rather than
 * the guard.
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'shared-sync.sh')

/** The `has_python` definition, lifted out of the script. */
function guardSource(): string {
  const lines = readFileSync(script, 'utf8').split('\n')
  const start = lines.findIndex((l) => l === 'has_python() {')
  expect(start, 'has_python() not found -- has it been renamed?').toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && l === '}')
  expect(end, 'no closing brace for has_python()').toBeGreaterThan(start)
  return lines.slice(start, end + 1).join('\n')
}

function callHasPython(d: string, base: string): { code: number; out: string } {
  const program = `${guardSource()}\nhas_python ${JSON.stringify(d)} ${JSON.stringify(base)}\n`
  try {
    const stdout = execFileSync('bash', ['-c', program], { encoding: 'utf8' })
    return { code: 0, out: stdout }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

const GIT_ID = [
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'user.name=Fixture',
  '-c',
  'commit.gpgsign=false',
]

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-C', dir, ...GIT_ID, ...args], { stdio: 'pipe' })
}

/** A real repo, on `dev`, with a real `origin` remote -- `has_python` reads
 * `origin/$base`, never the working tree. */
function makeRepo(root: string, opts: { hasPython?: boolean } = {}): string {
  const origin = join(root, 'origin.git')
  mkdirSync(origin, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin], { stdio: 'pipe' })

  const dir = join(root, 'clone')
  execFileSync('git', ['clone', '-q', origin, dir], { stdio: 'pipe' })
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  if (opts.hasPython) {
    mkdirSync(join(dir, 'services', 'api'), { recursive: true })
    writeFileSync(join(dir, 'services', 'api', 'pyproject.toml'), '[project]\nname = "fixture"\n')
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'chore: fixture repo')
  git(dir, 'push', '-q', 'origin', 'dev')
  return dir
}

describe('has_python', () => {
  it('reports python present for a repo carrying a nested pyproject.toml', () => {
    const root = makeTmpDir('has-python-yes')
    const dir = makeRepo(root, { hasPython: true })

    const { code } = callHasPython(dir, 'dev')

    expect(code).toBe(0)
  })

  it('reports python absent for a repo with no pyproject.toml anywhere', () => {
    const root = makeTmpDir('has-python-no')
    const dir = makeRepo(root, { hasPython: false })

    const { code } = callHasPython(dir, 'dev')

    expect(code).not.toBe(0)
  })

  it('does NOT report python absent when git itself fails -- fails closed toward inclusion', () => {
    const root = makeTmpDir('has-python-git-fails')
    // hasPython: true so a wrongly-"absent" verdict is distinguishable from a
    // correct one -- if the fix regressed to reading grep's exit status alone,
    // this would report absent (1) instead of the fail-closed present (0).
    const dir = makeRepo(root, { hasPython: true })

    // A ref that does not exist makes `git ls-tree` itself fail (`fatal: Not a
    // valid object name`), independent of the tree's actual content -- the
    // same shape a transient lock or resource hiccup produces: the command
    // errors, not "succeeds and finds nothing".
    const { code, out } = callHasPython(dir, 'this-branch-does-not-exist')

    expect(code, out).toBe(0)
  })
})
