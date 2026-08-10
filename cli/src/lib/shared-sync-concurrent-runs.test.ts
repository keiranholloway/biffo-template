import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTemplateCheckout, sharedSyncIn } from '../test-utils/shared-sync-template.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * #1160: two genuinely concurrent `shared-sync.sh` rounds against the same
 * repo must not destroy each other's staged worktree.
 *
 * ## The mechanism this reproduces
 *
 * `stage_repo`'s first act used to be an unconditional
 * `git worktree remove --force "$d/.worktrees/shared-sync"` against a FIXED,
 * unclaimed path with no locking anywhere (`grep -n 'flock\|lockfile\|
 * \.lock'` found nothing before this fix). So a second full round staging the
 * SAME repo at any point between a first round's phase 1 (staged, tree left
 * in place until phase 2) and phase 2 (shipped and reaped) would silently
 * delete the first round's staged tree — and the first round then reached
 * `ship_repo` to find it gone, reported as `staged worktree missing at ...`
 * (require_staged_worktree, added by #1161 to name this rather than blame the
 * push).
 *
 * That is exactly what this test drives: two real `sh scripts/shared-sync.sh`
 * processes, run concurrently against one fixture satellite, ordered so that
 * the second one's `stage_repo` executes squarely inside the first one's
 * staged-but-not-yet-shipped window.
 *
 * ## Why a controlled delay rather than relying on chance timing
 *
 * The window in an unlucky pair of real rounds is however long phase 1 takes
 * for the OTHER repos ahead of this one in the target list, plus all of phase
 * 2 for the ones before it — seconds to minutes in a real 13-repo round, and
 * not something a test should wait out or gamble on hitting. The fixture's
 * candidate `scripts/verify.sh` sleeps when `SHARED_SYNC_TEST_SLOW=1` is set
 * in its environment, which stalls process A inside its OWN phase-1 gate run
 * — after `stage_repo` has already staged the tree, before phase 2 reaches
 * it. That reconstructs the same relative ordering deterministically, using
 * the exact same code paths (the same `stage_repo`, the same unconditional
 * pre-remove pattern before the fix existed) two real overlapping rounds
 * would execute — it does not simulate the race, it removes the uncertainty
 * about WHEN the real one would land.
 *
 * ## Proven to fail without the fix
 *
 * Run by hand against `stage_repo`/`ship_repo` with `acquire_stage_lock`/
 * `release_stage_lock` stripped back to the original unconditional
 * `git worktree remove --force` (i.e. the tree at #1160's HEAD before this
 * change): process B silently removes and reships process A's staged tree,
 * and process A's stdout contains `staged worktree missing` with exit code 1
 * — every assertion below fails. See the PR body for the exact revert used.
 */

const SAT = 'sat-race'

const candidateVerify = `#!/usr/bin/env bash
set -u
[ "\${1:-}" = "--list" ] && exit 0
if [ "\${SHARED_SYNC_TEST_SLOW:-}" = "1" ]; then
  sleep "\${SHARED_SYNC_TEST_SLOW_SECONDS:-6}"
fi
printf 'verify passed - lint typecheck test\\n'
exit 0
`

function git(dir: string, ...args: string[]): void {
  spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
}

interface Estate {
  estateDir: string
  satDir: string
  script: string
  wtLog: string
  ghLog: string
  binDir: string
}

/** One satellite, drifted on the one candidate file the fixture manifest
 * names, plus the bridge `rehearse_repo` dispatches through and a fake `gh`
 * that answers `repo view`/`pr create` and logs every call. */
function buildEstate(): Estate {
  const root = makeTmpDir('concurrent-sync')
  const estateDir = join(root, 'estate')
  mkdirSync(estateDir, { recursive: true })

  const template = makeTemplateCheckout(root, {
    files: { 'scripts/verify.sh': candidateVerify },
  })
  const script = sharedSyncIn(template)

  const origin = join(root, `${SAT}.git`)
  spawnSync('git', ['init', '-q', '--bare', '-b', 'dev', origin], { stdio: 'pipe' })

  const satDir = join(estateDir, SAT)
  spawnSync('git', ['clone', '-q', origin, satDir], { stdio: 'pipe' })
  git(satDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'config', 'commit.gpgsign', 'false')

  writeFileSync(join(satDir, 'biffo.sibling.json'), '{}\n')
  writeFileSync(join(satDir, '.gitignore'), '.worktrees/\n')
  mkdirSync(join(satDir, 'scripts'), { recursive: true })
  // Deliberately stale, so `files` reports this repo drifted and stage_repo
  // has something to stage.
  writeFileSync(join(satDir, 'scripts', 'verify.sh'), '#!/bin/sh\nexit 0\n')
  writeFileSync(
    join(satDir, 'scripts', 'biffo.sh'),
    [
      '#!/bin/sh',
      '[ "$1" = verify ] || exit 0',
      'shift',
      'exec sh scripts/verify.sh "$@"',
      '',
    ].join('\n'),
  )
  chmodSync(join(satDir, 'scripts', 'biffo.sh'), 0o755)
  git(satDir, 'add', '-A')
  git(
    satDir,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'seed',
  )
  git(satDir, 'push', '-q', 'origin', 'dev')

  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  const ghLog = join(root, 'gh-calls.log')
  writeFileSync(ghLog, '')
  writeFileSync(
    join(binDir, 'gh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}
if [ "\${1:-}" = "repo" ] && [ "\${2:-}" = "view" ]; then echo dev; exit 0; fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "create" ]; then echo https://example.invalid/pr/1; exit 0; fi
exit 0
`,
  )
  chmodSync(join(binDir, 'gh'), 0o755)

  return { estateDir, satDir, script, wtLog: join(root, 'worktrees.log'), ghLog, binDir }
}

function baseEnv(e: Estate): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SHARED_SYNC_WT_LOG: e.wtLog,
    PATH: `${e.binDir}:${process.env.PATH ?? ''}`,
  }
}

const stagedWt = (e: Estate) => join(e.satDir, '.worktrees', 'shared-sync')

/** Poll until the staged worktree is fully populated (stage_repo's last
 * write), or fail — never a blind fixed delay before starting process B. */
async function waitForStaged(e: Estate, timeoutMs = 20_000): Promise<void> {
  const marker = join(stagedWt(e), '.biffo-shared-version')
  const start = Date.now()
  while (!existsSync(marker)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`process A never finished staging within ${timeoutMs}ms (${marker})`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; out: string }> {
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, out }))
  })
}

describe('two concurrent shared-sync rounds against one repo (#1160)', () => {
  it('the second round is refused loudly, and the first ships untouched', async () => {
    const e = buildEstate()

    // Process A: slow gate, generous lock wait (default 60s — it should never
    // need it, nothing is contending its OWN lock).
    const procA = spawn('bash', [e.script, '--estate', e.estateDir], {
      env: { ...baseEnv(e), SHARED_SYNC_TEST_SLOW: '1', SHARED_SYNC_TEST_SLOW_SECONDS: '6' },
    })
    const doneA = waitForExit(procA)

    await waitForStaged(e)
    // A has staged and is now inside its slow gate run — squarely between
    // phase 1 and phase 2. This is the window #1160 is about.
    expect(existsSync(stagedWt(e))).toBe(true)

    // Process B: fast gate, and a SHORT lock wait so the test does not sit
    // through a real timeout to prove the refusal — the wait loop itself is
    // covered by shared-sync-stage-lock.test.ts.
    const b = spawnSync('bash', [e.script, '--estate', e.estateDir], {
      env: { ...baseEnv(e), SHARED_SYNC_LOCK_WAIT: '1' },
      encoding: 'utf8',
      timeout: 20_000,
    })
    const bOut = `${b.stdout ?? ''}${b.stderr ?? ''}`

    // The fix: B is refused loudly, naming the collision, rather than
    // silently destroying A's staged tree.
    expect(bOut).toContain('CANNOT STAGE')
    expect(bOut).toContain('locked by pid')
    expect(b.status).not.toBe(0)

    // A's staged tree survived B's entire attempt.
    expect(existsSync(stagedWt(e))).toBe(true)

    const resultA = await doneA

    // The bug this reproduces: A reaching phase 2 to find its own tree gone.
    expect(resultA.out).not.toContain('staged worktree missing')
    expect(resultA.code).toBe(0)

    // Exactly one PR — B's refusal must not have opened a second one for the
    // same drift, and A's own round must have completed normally.
    const ghCalls = readFileSync(e.ghLog, 'utf8').split('\n').filter(Boolean)
    expect(ghCalls.filter((c) => c.startsWith('pr create'))).toHaveLength(1)

    // A reaped its own worktree on the success path (#1366) — nothing left
    // over from the round that actually shipped.
    expect(existsSync(stagedWt(e))).toBe(false)

    // The instrumentation from #1166 tells the same story, attributable by
    // pid, which is exactly what it was built to do: read upward from a
    // lock-related event and the interleaving is legible without needing this
    // test's own assertions.
    const log = readFileSync(e.wtLog, 'utf8')
    expect(log).toMatch(/lock-acquired/)
    expect(log).toMatch(/lock-TIMEOUT/)
  }, 30_000)
})
