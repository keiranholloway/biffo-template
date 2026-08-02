import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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
}

/**
 * A fake `gh` replaying one canned rollup per call, so a test describes a
 * *sequence* of poll results rather than a single state. The last entry repeats
 * once exhausted, so a test only spells out the states it cares about.
 */
function stubGh(options: StubOptions): string {
  const dir = mkdtempSync(join(tmpdir(), 'waitchecks-'))
  const counter = join(dir, 'calls')
  writeFileSync(counter, '0')

  const last = options.rollups.length - 1
  options.rollups.forEach((lines, i) => {
    writeFileSync(join(dir, 'rollup.' + i), lines.length > 0 ? lines.join('\n') + '\n' : '')
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

  it('exits 0 immediately on an already-merged PR', () => {
    const stub = stubGh({ rollups: [[]], state: 'MERGED', protectionFails: true })
    const { code, out } = run(stub, ['--timeout', '0'])

    expect(code).toBe(0)
    expect(out).toContain('MERGED')
  })
})
