/**
 * `verify.sh` leaves no orphaned scratch directory behind when it is killed
 * abnormally partway through a check (#1930).
 *
 * Every individual check that creates a temp dir/file already cleans it up
 * inline on its own pass/fail paths -- `gitleaks_tracked_only`'s `rm -rf
 * "$_gl_dir"`, `run_check`'s `rm -f "/tmp/biffo-verify.$$"`, `pg_test_run`'s
 * `rm -f "$_out"`. None of that runs if `verify.sh` itself is killed first --
 * a CI timeout, an interrupted local Ctrl-C, a supervising process sending
 * SIGTERM -- before the inline cleanup line is reached. That gap is what
 * actually accumulated hundreds of stale scratch dirs in /tmp with no
 * eviction, eventually driving it to 100% inode usage and breaking every
 * `fleet.sh` command that writes a temp file.
 *
 * `gitleaks_tracked_only` has the largest such window of any check in this
 * file: mirror-copy every tracked file, then a full `gitleaks detect` run,
 * all between the `mktemp -d` and the `rm -rf` that only fires on a normal
 * return. This test targets that window specifically, with a stubbed
 * `gitleaks` binary that sleeps, so the scratch dir is guaranteed to still
 * exist when the interrupt arrives.
 *
 * Signalling only `verify.sh`'s own pid (not its process group) defers the
 * shell's pending trap until the currently-running foreground command (the
 * stubbed `gitleaks detect` call) exits on its own -- confirmed empirically
 * against a minimal trap script before this test was written: a bare `kill
 * -TERM <pid>` sent to a dash script blocked on an external `sleep` does not
 * run the trap until that `sleep` finishes, no matter how long it runs.
 * That is not the real-world shape this issue is about: a terminal Ctrl-C, a
 * killed session, or a supervisor tearing down a process tree delivers the
 * signal to the whole process group, which also reaches the still-running
 * child and ends it immediately -- so the shell's wait() returns for real and
 * the pending trap runs right away. This test reproduces that shape:
 * `verify.sh` is spawned detached (its own process group) and signalled via
 * its negative pid, exactly as a terminal or process-tree kill would.
 */

import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../test-utils/tmp.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(repoRoot, 'scripts/verify.sh')

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** A minimal tracked-file repo, just enough for `gitleaks_tracked_only` to
 * have something to mirror-copy before it invokes `gitleaks`. */
function buildFixture(): string {
  const dir = makeTmpDir('verify-tmp-orphan')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dir },
  )
  // No "typecheck"/"format:check"/"test" scripts, so those JS checks report
  // `n/a` instead of running -- only "lint" exists, and it's instant.
  writeFileSync(join(dir, 'package.json'), '{"name":"p","scripts":{"lint":"true"}}\n')
  execFileSync('git', ['add', 'package.json'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-q', '-m', 'seed'],
    { cwd: dir },
  )
  return dir
}

/** A stub `gitleaks` on PATH that blocks for a while before exiting clean --
 * standing in for a real scan run against a large tree, so the scratch dir
 * `gitleaks_tracked_only` created is still there when the kill arrives. */
function buildGitleaksStub(fixtureDir: string): string {
  const stubBin = join(fixtureDir, '_stub-bin')
  mkdirSync(stubBin, { recursive: true })
  writeFileSync(join(stubBin, 'gitleaks'), '#!/bin/sh\nsleep 10\nexit 0\n')
  chmodSync(join(stubBin, 'gitleaks'), 0o755)
  return stubBin
}

function gitleaksScratchDirs(scratchTmp: string): string[] {
  return readdirSync(scratchTmp).filter((f) => f.startsWith('biffo-gitleaks.'))
}

describe('verify.sh leaves no orphaned /tmp scratch dir when killed mid-run (#1930)', () => {
  it('removes the gitleaks scratch dir even when interrupted mid-scan', async () => {
    const fixtureDir = buildFixture()
    const scratchTmp = makeTmpDir('verify-tmp-orphan-scratch')
    const stubBin = buildGitleaksStub(fixtureDir)

    const child = spawn('sh', [SCRIPT], {
      cwd: fixtureDir,
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        TMPDIR: scratchTmp,
        // Turns on every ci_has()-gated check -- harmless here, since the
        // other ci_has-gated checks (python, terraform-fmt,
        // practices-monotonic) are each ALSO gated on a file this minimal
        // fixture doesn't have, so only the gitleaks lane actually runs.
        NO_CI: '1',
      },
      stdio: 'ignore',
      // Its own process group, so the kill below can target the group
      // (verify.sh AND its currently-running `gitleaks` child) rather than
      // only the top pid -- see the file header for why that distinction
      // matters here.
      detached: true,
    })

    try {
      // Poll for the scratch dir rather than sleeping a fixed guess: the
      // absence of the thing being waited for must never read as "done" --
      // asserted explicitly below, not inferred from an empty directory.
      let found: string | undefined
      for (let i = 0; i < 50; i++) {
        found = gitleaksScratchDirs(scratchTmp)[0]
        if (found) break
        await sleep(100)
      }
      expect(
        found,
        'gitleaks_tracked_only never created its scratch dir -- fixture wiring is broken, not the thing under test',
      ).toBeDefined()

      // Simulate a terminal Ctrl-C / session kill / process-tree teardown:
      // signal the whole group, not just verify.sh's own pid.
      process.kill(-child.pid!, 'SIGTERM')
      await sleep(500)

      expect(gitleaksScratchDirs(scratchTmp)).toEqual([])
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // already gone
      }
      removeTmpDir(fixtureDir)
      removeTmpDir(scratchTmp)
    }
  })
})
