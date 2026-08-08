import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `.githooks/pre-push`'s claim-guard section (#1231 instance 2, #1327) had
 * exactly one documented way past a false positive: `BIFFO_SKIP_VERIFY`,
 * which does not target the claim guard at all — it short-circuits the WHOLE
 * hook at line ~30, before rewrite-scope-check, the claim guard, the pg-test
 * block gate and `verify` ever run. #1327's own incident: an agent hit a
 * false-positive claim block and reached for `BIFFO_SKIP_VERIFY`, correctly
 * reading "skip the claim guard" as the instruction and getting "skip ruff,
 * pyright, bandit, gitleaks and rewrite-scope too" as the result.
 *
 * `BIFFO_SKIP_CLAIM_GUARD` is the narrow escape hatch: it bypasses only the
 * `sh scripts/biffo.sh claim --guard` call. Everything else in the hook must
 * keep running — that is the property these tests exist to pin down, because
 * a broad hatch dressed up as a narrow one (or a narrow one that accidentally
 * skips more than it says) is invisible to a script that merely checks the
 * hook still refuses a real conflict.
 *
 * These tests drive the REAL `.githooks/pre-push` file, not a
 * reimplementation, with `scripts/biffo.sh` stubbed to log every subcommand
 * it is asked to run and to answer each one canned. That is what makes "did
 * the rest of the gate still run" something the test actually observes,
 * rather than something asserted about code nobody executed.
 */
const repoRoot = join(import.meta.dirname, '..', '..', '..')
const preqPush = join(repoRoot, '.githooks', 'pre-push')

interface StubOptions {
  /** Exit code `scripts/biffo.sh claim --guard <branch>` should return. */
  claimExit?: number
}

/**
 * Builds a throwaway git repo with its own `scripts/biffo.sh` stub and
 * checks out a branch naming an issue, so the hook's own
 * `git symbolic-ref`/`git rev-parse` calls resolve for real.
 */
function fixtureRepo(branch: string, options: StubOptions = {}): { dir: string; callLog: string } {
  const dir = makeTmpDir('claimescape')
  const callLog = join(dir, 'calls.log')
  writeFileSync(callLog, '')

  execFileSync('git', ['init', '-q', '-b', 'dev'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'chore: init'], { cwd: dir })
  execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: dir })

  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const claimExit = options.claimExit ?? 0
  const biffo = [
    '#!/usr/bin/env sh',
    `echo "biffo.sh $*" >> ${JSON.stringify(callLog)}`,
    'case "$1" in',
    '  rewrite-scope-check) cat >/dev/null; exit 0 ;;',
    `  claim) exit ${claimExit} ;;`,
    '  pgtest-diff-check) cat >/dev/null; exit 1 ;;',
    '  verify) exit 0 ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'scripts', 'biffo.sh'), biffo)
  chmodSync(join(dir, 'scripts', 'biffo.sh'), 0o755)

  return { dir, callLog }
}

function runHook(dir: string, env: Record<string, string> = {}) {
  // spawnSync (not execFileSync) because the hook's own messages go to
  // stderr, and execFileSync only returns stdout on a zero exit — a success
  // path that dropped stderr would make the BIFFO_SKIP_VERIFY regression test
  // below pass or fail by accident of which stream a message happened to use.
  const result = spawnSync('sh', [preqPush], {
    cwd: dir,
    // A plausible ref list on stdin, the shape git actually pipes in.
    input: 'refs/heads/x deadbeef refs/heads/x deadbeef\n',
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '',
      BIFFO_SKIP_VERIFY: '',
      BIFFO_SKIP_PGTEST: '',
      BIFFO_CLAIM_STRICT: '',
      BIFFO_SKIP_CLAIM_GUARD: '',
      ...env,
    },
  })
  return { code: result.status ?? 1, out: (result.stdout ?? '') + (result.stderr ?? '') }
}

describe('.githooks/pre-push claim-guard escape hatch (#1327)', () => {
  it('by default, the claim guard runs like any other push', () => {
    const { dir, callLog } = fixtureRepo('fix/1234-thing')
    const { code } = runHook(dir)

    expect(code).toBe(0)
    expect(readFileSync(callLog, 'utf8')).toContain('biffo.sh claim --guard fix/1234-thing')
  })

  it('BIFFO_SKIP_CLAIM_GUARD=1 skips ONLY the claim guard — the rest of the gate still runs', () => {
    const { dir, callLog } = fixtureRepo('fix/1234-thing')
    const { code } = runHook(dir, { BIFFO_SKIP_CLAIM_GUARD: '1' })

    expect(code).toBe(0)
    const calls = readFileSync(callLog, 'utf8')
    expect(calls).not.toContain('claim --guard')
    expect(calls).toContain('biffo.sh rewrite-scope-check')
    expect(calls).toContain('biffo.sh pgtest-diff-check')
    expect(calls).toContain('biffo.sh verify')
  })

  it('BIFFO_SKIP_CLAIM_GUARD=1 actually unblocks a real conflict, not just a push that was already free', () => {
    // claimExit=1 is "taken" -- without the hatch this must block the push.
    const { dir } = fixtureRepo('fix/1234-thing', { claimExit: 1 })
    const blocked = runHook(dir)
    expect(blocked.code).toBe(1)

    // With the hatch set, the same conflicting branch pushes clean.
    const { dir: dir2, callLog: callLog2 } = fixtureRepo('fix/1234-thing', { claimExit: 1 })
    const unblocked = runHook(dir2, { BIFFO_SKIP_CLAIM_GUARD: '1' })
    expect(unblocked.code, unblocked.out).toBe(0)
    expect(readFileSync(callLog2, 'utf8')).not.toContain('claim --guard')
  })

  it('BIFFO_SKIP_VERIFY=1 is unchanged: it still skips the WHOLE gate, claim guard included', () => {
    const { dir, callLog } = fixtureRepo('fix/1234-thing')
    const { code, out } = runHook(dir, { BIFFO_SKIP_VERIFY: '1' })

    expect(code).toBe(0)
    expect(out).toContain('BIFFO_SKIP_VERIFY')
    expect(readFileSync(callLog, 'utf8')).toBe('')
  })
})

describe('.githooks/pre-push: shell portability', () => {
  it('parses under sh, dash and bash', () => {
    for (const sh of ['sh', 'dash', 'bash']) {
      expect(() => execFileSync(sh, ['-n', preqPush])).not.toThrow()
    }
  })
})
