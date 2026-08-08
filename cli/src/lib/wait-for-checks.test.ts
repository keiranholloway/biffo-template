import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * The defect this script exists to prevent is a wait loop that reads "no checks
 * yet" as "all green", so the case that matters most is the **empty rollup**:
 * it must never exit 0, and it must not exit 1 either — it is "cannot tell".
 *
 * Everything here runs against a stubbed `gh` placed first on `PATH`, which is
 * what makes the racy sequences reproducible: a real PR cannot be asked to have
 * zero checks for exactly one poll, and that is precisely the window
 * `gh pr update-branch` opens.
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'wait-for-checks.sh')

interface StubOptions {
  /** One entry per poll; each is the `name\tstate` lines the script's --jq emits. */
  rollups: string[][]
  /** Required contexts branch protection reports. */
  required?: string[]
  /** PR state, default OPEN. */
  state?: string
  /** Make the protection lookup fail, forcing the stability fallback. */
  protectionFails?: boolean
  /**
   * One `mergeable` value per poll, last entry repeating — same shape as
   * `rollups`, because mergeability is a *sequence* too: GitHub answers UNKNOWN
   * for the first seconds after a push and only then resolves. Defaults to
   * MERGEABLE throughout.
   */
  mergeables?: string[]
}

/**
 * A fake `gh` replaying one canned rollup per call, so a test describes a
 * *sequence* of poll results rather than a single state. The last entry repeats
 * once exhausted, so a test only spells out the states it cares about.
 */
function stubGh(options: StubOptions): string {
  const dir = makeTmpDir('waitchecks')
  const counter = join(dir, 'calls')
  writeFileSync(counter, '0')
  const mergeCounter = join(dir, 'mergecalls')
  writeFileSync(mergeCounter, '0')

  const last = options.rollups.length - 1
  options.rollups.forEach((lines, i) => {
    writeFileSync(join(dir, 'rollup.' + i), lines.length > 0 ? lines.join('\n') + '\n' : '')
  })

  const mergeables = options.mergeables ?? ['MERGEABLE']
  const mergeLast = mergeables.length - 1
  mergeables.forEach((m, i) => {
    writeFileSync(join(dir, 'mergeable.' + i), m + '\n')
  })

  const protection = options.protectionFails
    ? ['  exit 1']
    : (options.required ?? []).map((c) => "  echo '" + c + "'")

  const gh = [
    '#!/usr/bin/env bash',
    'args="$*"',
    '',
    'if [[ "$args" == *"--json state,baseRefName"* ]]; then',
    "  printf '%s\\t%s\\n' '" + (options.state ?? 'OPEN') + "' 'dev'",
    '  exit 0',
    'fi',
    '',
    'if [[ "$args" == *"--json mergeable"* ]]; then',
    '  n=$(cat ' + JSON.stringify(mergeCounter) + ')',
    '  echo $((n + 1)) > ' + JSON.stringify(mergeCounter),
    '  [ "$n" -gt ' + mergeLast + ' ] && n=' + mergeLast,
    '  cat ' + JSON.stringify(join(dir, 'mergeable.')) + '"$n"',
    '  exit 0',
    'fi',
    '',
    'if [[ "$args" == *nameWithOwner* ]]; then',
    "  echo 'acme/widget'",
    '  exit 0',
    'fi',
    '',
    'if [[ "$args" == *protection* ]]; then',
    ...protection,
    '  exit 0',
    'fi',
    '',
    'if [[ "$args" == *statusCheckRollup* ]]; then',
    '  n=$(cat ' + JSON.stringify(counter) + ')',
    '  echo $((n + 1)) > ' + JSON.stringify(counter),
    '  [ "$n" -gt ' + last + ' ] && n=' + last,
    '  cat ' + JSON.stringify(join(dir, 'rollup.')) + '"$n"',
    '  exit 0',
    'fi',
    '',
    'exit 0',
    '',
  ].join('\n')

  writeFileSync(join(dir, 'gh'), gh)
  chmodSync(join(dir, 'gh'), 0o755)
  return dir
}

/**
 * A `gh` stub that runs the script's REAL `--jq` filter — via the system `jq`
 * — against raw `statusCheckRollup` JSON, the same pattern
 * `claim-holder.test.ts` uses to test `claim.sh`'s own `--jq` filter for real.
 *
 * `stubGh` above hands the polling loop pre-flattened `name\tstate` lines, so
 * it never exercises the jq program at all — every existing test in this file
 * would pass unchanged whether or not the dedupe fix below is present. This is
 * the one that actually proves it: it hands `gh` the two-row shape
 * `statusCheckRollup` returns for a re-run (old FAILURE row untouched, new
 * SUCCESS row appended) and lets the script's own jq resolve it, matching
 * PR #1332's real payload (#1333).
 */
function stubGhRaw(rollup: unknown[]): string {
  const dir = makeTmpDir('waitchecks-raw')
  const fixture = join(dir, 'rollup.json')
  writeFileSync(fixture, JSON.stringify({ statusCheckRollup: rollup }))

  const gh = [
    '#!/usr/bin/env bash',
    'args="$*"',
    '',
    'if [[ "$args" == *"--json state,baseRefName"* ]]; then',
    "  printf '%s\\t%s\\n' 'OPEN' 'dev'",
    '  exit 0',
    'fi',
    '',
    'if [[ "$args" == *"--json mergeable"* ]]; then',
    "  echo 'MERGEABLE'",
    '  exit 0',
    'fi',
    '',
    'if [[ "$args" == *nameWithOwner* ]]; then',
    "  echo 'acme/widget'",
    '  exit 0',
    'fi',
    '',
    // No readable protection — forces the stability fallback, same as most
    // `stubGh` tests above, so this exercises only the dedupe under test.
    'if [[ "$args" == *protection* ]]; then',
    '  exit 1',
    'fi',
    '',
    'if [[ "$args" == *statusCheckRollup* ]]; then',
    '  prev=""',
    '  jqexpr=""',
    '  for a in "$@"; do if [ "$prev" = "--jq" ]; then jqexpr="$a"; fi; prev="$a"; done',
    `  jq -r "$jqexpr" ${JSON.stringify(fixture)}`,
    '  exit 0',
    'fi',
    '',
    'exit 0',
    '',
  ].join('\n')

  writeFileSync(join(dir, 'gh'), gh)
  chmodSync(join(dir, 'gh'), 0o755)
  return dir
}

function checkRun(name: string, conclusion: string, startedAt: string, completedAt: string) {
  return {
    __typename: 'CheckRun',
    name,
    workflowName: name,
    status: 'COMPLETED',
    conclusion,
    startedAt,
    completedAt,
  }
}

function run(stubDir: string, args: string[] = []) {
  try {
    const stdout = execFileSync('bash', [script, '123', '--interval', '0', ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: stubDir + ':' + process.env.PATH },
    })
    return { code: 0, out: stdout }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('wait-for-checks', () => {
  it('NEVER reports success on an empty rollup — the defect it exists to prevent', () => {
    // The `gh pr update-branch` window: superseded runs dropped, new ones not
    // yet registered.
    //
    // The timeout MUST allow at least two polls. With `--timeout 0` this test
    // passes against a deliberately broken script, because the deadline fires
    // on the first iteration before the empty-set condition is ever evaluated —
    // it would be asserting that the timeout works, not that the guard does.
    // Verified by reverting `count -gt 0` to `true` and watching this fail.
    const stub = stubGh({ rollups: [[]], protectionFails: true })
    const { code, out } = run(stub, ['--timeout', '2', '--interval', '1'])

    expect(code).toBe(2)
    expect(out).toContain('No checks ever appeared')
    expect(out).toContain("not 'green'")
  })

  it('waits through the empty window and then passes', () => {
    const stub = stubGh({
      rollups: [[], ['CI\tPENDING'], ['CI\tSUCCESS'], ['CI\tSUCCESS']],
      protectionFails: true,
    })
    const { code, out } = run(stub, ['--timeout', '60'])

    expect(code).toBe(0)
    expect(out).toContain('All checks concluded')
  })

  it('does not stop when one fast check concludes while others are registering', () => {
    // Secret Scan finishes in ~9s; E2E takes ~3.5m and registers later. Without
    // the stability requirement this exits green having seen one check.
    const stub = stubGh({
      rollups: [
        ['Secret Scan\tSUCCESS'],
        ['Secret Scan\tSUCCESS', 'E2E\tPENDING'],
        ['Secret Scan\tSUCCESS', 'E2E\tFAILURE'],
        ['Secret Scan\tSUCCESS', 'E2E\tFAILURE'],
      ],
      protectionFails: true,
    })
    const { code, out } = run(stub, ['--timeout', '60'])

    expect(code).toBe(1)
    expect(out).toContain('E2E')
  })

  it('uses branch protection as the strong signal when it is readable', () => {
    // Two of three required contexts have reported. A count-based condition is
    // satisfied here; a required-context one is not.
    const stub = stubGh({
      required: ['CI', 'Secret Scan', 'E2E'],
      rollups: [
        ['CI\tSUCCESS', 'Secret Scan\tSUCCESS'],
        ['CI\tSUCCESS', 'Secret Scan\tSUCCESS'],
        ['CI\tSUCCESS', 'Secret Scan\tSUCCESS', 'E2E\tSUCCESS'],
      ],
    })
    const { code, out } = run(stub, ['--timeout', '60'])

    expect(code).toBe(0)
    expect(out).toContain('3 required check')
  })

  it('times out with exit 2 rather than 0 when a check never finishes', () => {
    const stub = stubGh({ rollups: [['CI\tPENDING']], protectionFails: true })
    const { code, out } = run(stub, ['--timeout', '0'])

    expect(code).toBe(2)
    expect(out).toContain('Still unfinished')
    expect(out).toContain('CI')
  })

  it('reports a failure as exit 1, naming the check', () => {
    const stub = stubGh({ rollups: [['CI\tFAILURE'], ['CI\tFAILURE']], protectionFails: true })
    const { code, out } = run(stub, ['--timeout', '60'])

    expect(code).toBe(1)
    expect(out).toContain('Failed:')
    expect(out).toContain('CI')
  })

  it('separates a cancelled check from a real failure', () => {
    // On self-hosted runners `cancelled` is usually spot reclamation or a
    // cancel-in-progress group — still exit 1, but do not send anyone hunting a
    // code defect.
    const stub = stubGh({ rollups: [['CI\tCANCELLED'], ['CI\tCANCELLED']], protectionFails: true })
    const { code, out } = run(stub, ['--timeout', '60'])

    expect(code).toBe(1)
    expect(out).toContain('Cancelled')
    expect(out).toContain('infrastructure')
    expect(out).not.toContain('Failed:')
  })

  it('treats skipped and neutral as concluded, not as failures', () => {
    const stub = stubGh({
      rollups: [
        ['CI\tSUCCESS', 'CodeQL\tSKIPPED', 'Lint\tNEUTRAL'],
        ['CI\tSUCCESS', 'CodeQL\tSKIPPED', 'Lint\tNEUTRAL'],
      ],
      protectionFails: true,
    })

    expect(run(stub, ['--timeout', '60']).code).toBe(0)
  })

  it('fails fast on a CONFLICTING PR instead of waiting out the timeout', () => {
    // GitHub creates no check runs for a PR whose merge commit it cannot
    // compute, so the rollup stays empty forever. Before #1246 this was
    // indistinguishable from "CI has not started yet" and PR #1243 burned ten
    // minutes on it.
    //
    // The exit code alone cannot prove the fix — an unfixed script also reaches
    // 2, just via the timeout — so this asserts on *which* 2 it is: the reason
    // must name the conflict, and the timeout must not have been reached.
    const stub = stubGh({
      required: ['CI', 'Secret Scan'],
      rollups: [[]],
      mergeables: ['CONFLICTING'],
    })
    const { code, out } = run(stub, ['--timeout', '30', '--interval', '1'])

    expect(code).toBe(2)
    expect(out).toContain('conflicts with dev')
    expect(out).toContain('will never appear')
    expect(out).toContain('not a pass')
    expect(out).not.toContain('timed out')
    expect(out).not.toContain('All checks concluded')
  })

  it('exits 2 when a conflict appears after the checks have started', () => {
    // A merge into the base branch can conflict a PR that was clean when the
    // wait began, so mergeability is re-read every poll rather than once.
    const stub = stubGh({
      rollups: [['CI\tPENDING'], ['CI\tPENDING']],
      mergeables: ['MERGEABLE', 'CONFLICTING'],
      protectionFails: true,
    })
    const { code, out } = run(stub, ['--timeout', '30', '--interval', '1'])

    expect(code).toBe(2)
    expect(out).toContain('conflicts with dev')
    expect(out).not.toContain('timed out')
  })

  it('KEEPS WAITING on UNKNOWN — GitHub returns it while computing mergeability', () => {
    // UNKNOWN is the transient answer for the first seconds after every push.
    // Treating it as a conflict would be a fresh fail-fast bug, so this is the
    // counterweight to the test above: same field, opposite obligation.
    const stub = stubGh({
      rollups: [[], ['CI\tPENDING'], ['CI\tSUCCESS'], ['CI\tSUCCESS']],
      mergeables: ['UNKNOWN', 'UNKNOWN', 'MERGEABLE'],
      protectionFails: true,
    })
    const { code, out } = run(stub, ['--timeout', '60'])

    expect(code).toBe(0)
    expect(out).toContain('All checks concluded')
    expect(out).not.toContain('conflicts with')
  })

  it('still passes a MERGEABLE PR whose required checks are all green', () => {
    const stub = stubGh({
      required: ['CI', 'Secret Scan'],
      rollups: [['CI\tSUCCESS', 'Secret Scan\tSUCCESS']],
      mergeables: ['MERGEABLE'],
    })
    const { code, out } = run(stub, ['--timeout', '60'])

    expect(code).toBe(0)
    expect(out).toContain('All checks concluded')
  })

  it('does not treat an unreadable mergeable field as a conflict', () => {
    // An old `gh`, or a token without the scope, yields an empty string. A field
    // the script cannot read must never become a verdict.
    const stub = stubGh({
      rollups: [['CI\tSUCCESS'], ['CI\tSUCCESS']],
      mergeables: [''],
      protectionFails: true,
    })
    const { code } = run(stub, ['--timeout', '60'])

    expect(code).toBe(0)
  })

  it('exits 0 immediately on an already-merged PR', () => {
    const stub = stubGh({ rollups: [[]], state: 'MERGED', protectionFails: true })
    const { code, out } = run(stub, ['--timeout', '0'])

    expect(code).toBe(0)
    expect(out).toContain('MERGED')
  })

  describe('disagreement: a superseded run must not outvote its replacement (#1333, class #1362)', () => {
    // The guard (this script, reading every row `statusCheckRollup` returns)
    // and the authority (GitHub's merge gate and `gh pr checks`, which both
    // resolve a name to its LATEST run) must agree. These construct the exact
    // state where a naive "any row says FAILURE" reading disagrees with that
    // authority, and assert the script returns what the authority returns —
    // in both directions, so the fix is a resolution rule and not a rule that
    // only ever forgives.

    it('a stale FAILURE superseded by a newer SUCCESS passes — matching GitHub, not the raw rollup', () => {
      // PR #1332's actual shape: Release Guards failed once, the PR body was
      // corrected, `edited` re-ran it (#1319), and the re-run passed. Both rows
      // are real and both are still in `statusCheckRollup` — only their
      // `startedAt`/`completedAt` order says which one counts.
      const stub = stubGhRaw([
        checkRun('Release Guards', 'FAILURE', '2026-08-05T12:14:26Z', '2026-08-05T12:14:47Z'),
        checkRun('Release Guards', 'SUCCESS', '2026-08-05T12:18:04Z', '2026-08-05T12:18:27Z'),
      ])
      const { code, out } = run(stub, ['--timeout', '60'])

      expect(code, out).toBe(0)
      expect(out).toContain('All checks concluded')
    })

    it('the inverse: a newer FAILURE after an older SUCCESS still fails — this is not a gate that can only forgive', () => {
      const stub = stubGhRaw([
        checkRun('CI', 'SUCCESS', '2026-08-05T12:14:26Z', '2026-08-05T12:15:00Z'),
        checkRun('CI', 'FAILURE', '2026-08-05T12:20:00Z', '2026-08-05T12:21:00Z'),
      ])
      const { code, out } = run(stub, ['--timeout', '60'])

      expect(code, out).toBe(1)
      expect(out).toContain('Failed:')
      expect(out).toContain('CI')
    })
  })
})
