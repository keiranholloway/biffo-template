import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// Not mkdtempSync: `no-raw-mkdtemp.test.ts` walks the AST of every test file and
// fails a direct call. makeTmpDir registers the directory for an automatic sweep,
// because 71 hand-wired cleanups leaked for days until unrelated tooling died
// with ENOSPC — which happened twice again today.
import { makeTmpDir } from '../test-utils/tmp.js'
import { findPackagedScript } from './packaged-scripts.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * The bridge and the packaged script, together (#1109).
 *
 * These guard the first guard moved off copy-based distribution. The estate
 * copied 16 files into 15 repos — roughly 240 copies kept identical by hand —
 * and about ten of its guards existed only to police that. Moving one script
 * into the versioned package is the proof that the copies are unnecessary.
 */
describe('packaged scripts resolve from a checkout', () => {
  it('finds the script by walking up, from src or dist', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    expect(findPackagedScript(here, 'scripts/wait-for-checks.sh')).toBeTruthy()
  })

  it('returns null rather than throwing when the asset is absent', () => {
    // A missing packaged asset must be reportable, not a crash: the caller
    // turns it into a message naming the packaging step, because "not found"
    // sends the reader to the wrong layer (#1160).
    const dir = makeTmpDir('pkgscript')
    expect(findPackagedScript(dir, 'scripts/does-not-exist.sh')).toBeNull()
  })

  it('is registered as a packaged asset, or it breaks only on a real npm install', async () => {
    // The failure mode this pins: the upward walk reaches the repo root in a
    // checkout, so a forgotten packaging entry is invisible in CI and breaks
    // only for someone who installed the published package. That is exactly
    // how #259 and #315 shipped.
    const { PACKAGED_ROOT_ASSETS } = (await import(
      join(repoRoot, 'cli/scripts/packaged-root-assets.mjs')
    )) as { PACKAGED_ROOT_ASSETS: { path: string }[] }
    expect(PACKAGED_ROOT_ASSETS.map((a) => a.path)).toContain('scripts/wait-for-checks.sh')
  })
})

describe('scripts/biffo.sh preserves the child exit code', () => {
  // The estate's wait/health scripts use a THREE-valued contract — 0 green,
  // 1 failed, 2 cannot tell — and "cannot tell" is never a pass. The bridge
  // used `pnpm --filter @biffo/cli exec`, which normalises every non-zero exit
  // to 1, so a `2` arrived as a `1` in the template. Safe by luck in that
  // direction; the reverse collapse would be a fail-open.
  it('passes 2 through rather than flattening it to 1', () => {
    const result = spawnSync(
      'sh',
      [
        join(repoRoot, 'scripts/biffo.sh'),
        'wait-for-checks',
        '999999999',
        '-R',
        'keiranholloway/biffo-template',
      ],
      { encoding: 'utf8', cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    // 2 = cannot tell (no such PR). If this ever reads 1, the bridge has gone
    // back to a wrapper that rewrites its child's status.
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(2)
  })
})

describe('scripts/biffo.sh resolves a satellite through its shared-version pin', () => {
  /**
   * A satellite carries neither `biffo.core.json` nor `cli/`. It carries
   * `.biffo-shared-version` (e.g. `core-v0.231.2`), written by `shared-sync.sh`.
   * Before #1109 the bridge had no branch for that, so satellites could not run
   * the CLI at all — which is why they received copied scripts instead.
   */
  it('reads .biffo-shared-version and asks npm for that exact version', () => {
    const dir = makeTmpDir('satellite')
    {
      execFileSync('git', ['init', '-q', dir])
      writeFileSync(join(dir, '.biffo-shared-version'), 'core-v0.231.2\n')
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      // A stub `npx` first on PATH: this asserts WHICH version the bridge asks
      // for, without a network round trip. Running the real npx here would make
      // the test slow, flaky, and dependent on the registry.
      const bin = join(dir, 'stubbin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'npx'), '#!/bin/sh\necho "npx $*"\n', { mode: 0o755 })

      const result = spawnSync('sh', [join(repoRoot, 'scripts/biffo.sh'), 'wait-for-checks', '1'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      })

      expect(`${result.stdout}${result.stderr}`).toContain('@biffo/cli@0.231.2')
      // The `core-v` prefix is a git tag convention; npm does not know it.
      expect(`${result.stdout}${result.stderr}`).not.toContain('core-vcore-v')
      expect(`${result.stdout}${result.stderr}`).not.toContain('@biffo/cli@core-v')
    }
  })

  it('refuses an empty pin rather than resolving to @latest', () => {
    // `npx @biffo/cli@` resolves to the newest published version, which would
    // silently run guards a satellite has never adopted. Failing closed is the
    // whole point of pinning.
    const dir = makeTmpDir('satellite')
    {
      execFileSync('git', ['init', '-q', dir])
      writeFileSync(join(dir, '.biffo-shared-version'), '\n')
      const result = spawnSync('sh', [join(repoRoot, 'scripts/biffo.sh'), 'wait-for-checks', '1'], {
        cwd: dir,
        encoding: 'utf8',
      })
      expect(result.status).toBe(2)
      expect(`${result.stdout}${result.stderr}`).toContain('carries no readable version')
    }
  })
})

describe('the copy it replaces', () => {
  it('still exists, because Phase 0 proves the path before removing anything', () => {
    // Deliberate: `scripts/wait-for-checks.sh` stays in `shared-files.json` until
    // a published version carrying the subcommand has been proven from a real
    // satellite. Removing it from the shared set only stops shared-sync KEEPING
    // it in step — it does not delete the 15 existing copies, so removing it
    // early would leave stale scripts drifting silently, which is worse than
    // the state being fixed.
    expect(existsSync(join(repoRoot, 'scripts/wait-for-checks.sh'))).toBe(true)
  })
})
