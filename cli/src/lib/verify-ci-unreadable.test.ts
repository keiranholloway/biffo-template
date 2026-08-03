/**
 * `verify.sh`'s `ci_has()` must not let "the CI definition could not be read"
 * read as "no CI to mirror" (#1218).
 *
 * `[ -f .github/workflows/ci.yml ]` is true for a file that exists but cannot
 * be opened -- a permissions oddity, a partial checkout -- so a repo in that
 * state never sets `NO_CI` (it LOOKS like it has CI) and never gets the
 * best-effort fallback #942 built for a repo with none. Instead every
 * `ci_has()` call would ask `grep`, `grep` would fail to even open the file
 * (exit 2, "cannot open" -- not the exit 1 it returns for "read fine, found
 * nothing"), and the `&&` every call site gates on treats both alike: the
 * check silently leaves verify's scope. That is worse than "ran nothing",
 * because checks that do not gate on `ci_has()` at all (JS lint/format among
 * them) still run and pass, so the gate never reaches the "ran NOTHING"
 * branch verify-no-ci.test.ts covers -- it prints `verify passed` having
 * covered less than it claims, with nothing in the summary naming what went
 * missing.
 *
 * These tests pin the fix: an unreadable-but-present `ci.yml` fails the whole
 * gate immediately with exit 2, the estate's "cannot tell" convention shared
 * with wait-for-checks.sh, branch-health.sh and claim.sh (2 is never a pass).
 * A genuinely absent `ci.yml` must keep behaving exactly as #942 established
 * -- best-effort, exit 0 -- and this file re-asserts that boundary so a future
 * "fix" cannot collapse the two cases back into each other from the other
 * direction.
 *
 * Driven by running the real script against a fixture repo, not by reading
 * the source: the defect is in the script's exit status and output, and
 * asserting on source text would be the substring-guard mistake #957 exists to
 * stop.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(repoRoot, 'scripts/verify.sh')

interface Run {
  stdout: string
  status: number
}

const CI_YML = 'jobs:\n  js:\n    steps:\n      - run: pnpm run lint\n'

/**
 * `chmod 000` does not deny root -- the owner-permission bits it clears are
 * exactly what root ignores by design, so the two "unreadable" cases below
 * would silently pass on a runner executing as root regardless of whether the
 * fix works, which is worse than not testing it at all. Explicit and visible,
 * same shape as `HAS_GITLEAKS` in verify-gitleaks-scope.test.ts, rather than a
 * green result nobody can trust.
 */
const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

/**
 * @param listMode pass `--list` instead of running for real. `--list` reports
 *   what THIS REPO requires -- and with `ci.yml` unreadable it cannot answer
 *   that question either, so it must fail exactly the same way as an ordinary
 *   run rather than silently reporting a truncated check set.
 */
function runIn(files: Record<string, string>, unreadable: string[], listMode = false): Run {
  const dir = makeTmpDir('biffo-verify-ci-unreadable')
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body)
    }
    for (const rel of unreadable) {
      chmodSync(join(dir, rel), 0o000)
    }
    const opts: ExecFileSyncOptions = { cwd: dir, encoding: 'utf8', stdio: 'pipe' }
    const args = listMode ? [SCRIPT, '--list'] : [SCRIPT]
    try {
      return { stdout: String(execFileSync('sh', args, opts)), status: 0 }
    } catch (err) {
      const e = err as { stdout?: string; status?: number }
      return { stdout: String(e.stdout ?? ''), status: e.status ?? -1 }
    }
  } finally {
    // Restore permissions before the recursive rmSync -- an unreadable file
    // this process itself made unreadable can otherwise refuse its own cleanup.
    for (const rel of unreadable) {
      try {
        chmodSync(join(dir, rel), 0o644)
      } catch {
        // already gone, or never existed on this platform's chmod semantics
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("verify.sh fails closed when ci.yml can't be read (#1218)", () => {
  it.skipIf(RUNNING_AS_ROOT)(
    'CANNOT TELLs, exit 2, when ci.yml exists but is unreadable -- even though another check passes',
    () => {
      // The JS lint check does not gate on ci_has() at all, so it still runs
      // and passes -- reproducing the exact shape of the bug: something DOES
      // pass, so the gate never reaches the "ran NOTHING" branch and would
      // otherwise print `verify passed` while every ci_has()-gated check
      // vanished silently.
      const run = runIn(
        {
          'package.json': '{"name":"p","scripts":{"lint":"true"}}\n',
          '.github/workflows/ci.yml': CI_YML,
        },
        ['.github/workflows/ci.yml'],
      )

      expect(run.status).toBe(2)
      expect(run.stdout).toContain('CANNOT TELL')
      expect(run.stdout).not.toContain('verify passed')
    },
  )

  it.skipIf(RUNNING_AS_ROOT)(
    'CANNOT TELLs the same way under --list, which cannot answer the question either',
    () => {
      const run = runIn({ '.github/workflows/ci.yml': CI_YML }, ['.github/workflows/ci.yml'], true)

      expect(run.status).toBe(2)
      expect(run.stdout).toContain('CANNOT TELL')
    },
  )

  it('does NOT fire for a genuinely absent ci.yml -- that stays #942s best-effort pass', () => {
    const run = runIn({ 'package.json': '{"name":"p","scripts":{"lint":"true"}}\n' }, [])

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('verify passed')
    expect(run.stdout).not.toContain('CANNOT TELL')
  })

  it('does NOT fire for a normal, readable ci.yml', () => {
    const run = runIn(
      {
        'package.json': '{"name":"p","scripts":{"lint":"true"}}\n',
        '.github/workflows/ci.yml': CI_YML,
      },
      [],
    )

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('verify passed')
    expect(run.stdout).not.toContain('CANNOT TELL')
  })
})
