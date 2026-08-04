/**
 * The estate-audit harness must survive its own audits, and must never leave a
 * half-written file behind.
 *
 * On 2026-08-04 the 04:30 collection died 18 seconds in. `practices-daily.sh`
 * runs under `set -euo pipefail`, and `audit_json` extracted each audit's
 * headline with `... | grep -E "$3" | tail -1 | sed ...`. Under `pipefail` a
 * grep MISS fails that whole pipeline, the assignment carries the status, and
 * `set -e` kills the run — so the `${_summary:-no summary line}` fallback on the
 * very next line had been unreachable dead code for as long as it had existed.
 *
 * The cost was not one audit. Nine of ten never ran; the dashboard was never
 * re-rendered (the bookmarked page went on showing the previous day, and the
 * failing-audit notification never fired because nothing reached it); the day's
 * snapshot was never committed or pushed; and `estate-audits.json` was left at
 * 129 bytes ending in a comma, which threw `SyntaxError: Unexpected end of JSON
 * input` in `practices-standup.mjs` and blocked the morning standup outright.
 *
 * The script's own comments argue at length that "a failing audit must REPORT,
 * not abort ... fail-open's mirror image, and just as useless", and guard the
 * audit COMMAND's exit code accordingly. The summary extraction, two lines
 * below, was equally lethal and unguarded. That is the thing worth pinning: the
 * intent was written down, and one construct defeated it.
 *
 * These tests execute the real `audit_json` lifted out of the shell script,
 * rather than asserting on its source text — the same arrangement as
 * `practices-daily-alert.test.ts`, and for the same reason: a substring guard
 * passes against a script that never runs the code.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
// @ts-expect-error -- plain .mjs so the standup runs on bare node.
import { readAudits } from '../../../scripts/practices-standup.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const DAILY = join(repoRoot, 'scripts/practices-daily.sh')
const ASSEMBLE = join(repoRoot, 'scripts/practices-audit-assemble.mjs')

/** The real `audit_json`, lifted so it can be driven without a 5-minute run. */
let auditJson = ''

beforeAll(() => {
  const src = readFileSync(DAILY, 'utf8')
  const start = src.indexOf('audit_json() {')
  if (start === -1) throw new Error('audit_json not found in practices-daily.sh')
  auditJson = src.slice(start, src.indexOf('\n}\n', start) + 3)
})

interface Run {
  status: number
  stdout: string
  audits: { name: string; ok: boolean; exit: number | null; summary: string; ranNot?: boolean }[]
  raw: string
}

/**
 * Run a sequence of `audit_json` calls through the real function, under the same
 * `set -euo pipefail` the daily script uses, and assemble the result.
 *
 * `pipefail` is the load-bearing part of this harness. Without it the original
 * bug does not reproduce at all, and the test would pass against the broken
 * script — which is precisely the fail-open shape these tests exist to catch.
 */
function runAudits(calls: string[], expected: string, dir: string): Run {
  const out = join(dir, 'estate-audits.json')
  const script = join(dir, 'harness.sh')
  writeFileSync(
    script,
    [
      'set -euo pipefail',
      `AUDIT_LINES=$(mktemp)`,
      auditJson,
      ...calls,
      `node ${JSON.stringify(ASSEMBLE)} --lines "$AUDIT_LINES" --expected ${JSON.stringify(expected)} --collected-at '2026-08-04T03:41:16Z' --out ${JSON.stringify(out)}`,
      'rm -f "$AUDIT_LINES"',
      'echo REACHED_THE_END',
    ].join('\n'),
  )

  let status = 0
  let stdout = ''
  try {
    stdout = execFileSync('bash', [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    const e = err as { status?: number; stdout?: string }
    status = e.status ?? 1
    stdout = e.stdout ?? ''
  }

  let raw = ''
  try {
    raw = readFileSync(out, 'utf8')
  } catch {
    raw = ''
  }
  return { status, stdout, raw, audits: raw ? JSON.parse(raw).audits : [] }
}

describe('audit_json survives an audit whose summary line does not match', () => {
  /**
   * The regression test. Against the pre-fix script this fails on every
   * assertion: the run exits 1 at the second call, `REACHED_THE_END` is never
   * printed, and the third audit never happens.
   */
  it('runs every subsequent audit after a grep miss', () => {
    const dir = makeTmpDir('audit-harness')
    const run = runAudits(
      [
        `audit_json first "echo hello-world" 'hello'`,
        `audit_json second "echo nothing-matches-here" '^[0-9]+ working trees'`,
        `audit_json third "echo still-running" 'still'`,
      ],
      'first second third',
      dir,
    )

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('REACHED_THE_END')
    expect(run.audits.map((a) => a.name)).toEqual(['first', 'second', 'third'])
    expect(run.audits[2].summary).toBe('still-running')
  })

  /**
   * A no-match used to report the constant "no summary line" and discard the
   * audit's output. That is why the 2026-08-04 root cause is unrecoverable: the
   * `arming` audit produced something, and nothing kept it.
   */
  it('preserves the audit output so a no-match is diagnosable', () => {
    const dir = makeTmpDir('audit-harness')
    const run = runAudits(
      [`audit_json arming "echo 'DEAD working trees:'" '^[0-9]+ working trees'`],
      'arming',
      dir,
    )

    expect(run.audits[0].summary).toContain('no line matched')
    expect(run.audits[0].summary).toContain('DEAD working trees:')
  })

  it('still reports a failing audit as failing', () => {
    const dir = makeTmpDir('audit-harness')
    const run = runAudits(
      [`audit_json drift "echo '3 current, 2 drifted'; exit 1" 'current, .* drifted'`],
      'drift',
      dir,
    )

    expect(run.status).toBe(0)
    expect(run.audits[0]).toMatchObject({
      name: 'drift',
      ok: false,
      exit: 1,
      summary: '3 current, 2 drifted',
    })
  })
})

describe('the assembled file is always well-formed', () => {
  it('records an audit that never ran as an explicit failure, not an absence', () => {
    const dir = makeTmpDir('audit-harness')
    const run = runAudits(
      [`audit_json coverage "echo 'covers its own CI'" 'covers its own CI'`],
      'coverage arming drift',
      dir,
    )

    expect(run.audits.map((a) => a.name)).toEqual(['coverage', 'arming', 'drift'])
    // ok:false is what makes the existing failing-audit notification in
    // practices-daily.sh pick these up with no extra plumbing.
    expect(run.audits[1]).toMatchObject({ name: 'arming', ok: false, ranNot: true })
    expect(run.audits[2].summary).toContain('did not run')
  })

  it('parses as JSON even when a result line is corrupt', () => {
    const dir = makeTmpDir('audit-harness')
    const out = join(dir, 'estate-audits.json')
    const lines = join(dir, 'lines')
    writeFileSync(
      lines,
      `{"name":"coverage","ok":true,"exit":0,"summary":"fine"}\n{"name":"trunc",\n`,
    )
    execFileSync(
      'node',
      [ASSEMBLE, '--lines', lines, '--expected', 'coverage arming', '--out', out],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    const doc = JSON.parse(readFileSync(out, 'utf8'))
    expect(doc.audits.map((a: { name: string }) => a.name)).toEqual(['coverage', 'arming'])
    expect(doc.malformedLines).toBe(1)
  })

  it('exits 0 so a bad audit cannot take down the dashboard render that follows', () => {
    const dir = makeTmpDir('audit-harness')
    const out = join(dir, 'estate-audits.json')
    const lines = join(dir, 'lines')
    writeFileSync(lines, '')
    const status = (() => {
      try {
        execFileSync('node', [ASSEMBLE, '--lines', lines, '--expected', 'coverage', '--out', out], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        return 0
      } catch (err) {
        return (err as { status?: number }).status ?? 1
      }
    })()

    expect(status).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8')).audits[0].ranNot).toBe(true)
  })
})

/**
 * `AUDIT_EXPECTED` is a second copy of something the script already states — the
 * set of audits it runs — and this repo has been bitten by second copies of a
 * decision often enough to name the shape (AGENTS.md §1, on why claiming checks
 * four signals rather than one label).
 *
 * Keeping it is still the right trade: deriving the list by parsing the script's
 * own calls at run time would mean the file that failed to run an audit is also
 * the authority on whether it should have. But the copy has to be pinned, or the
 * eleventh audit is added and silently never checked for absence.
 */
describe('the expected-audit list matches the audits actually called', () => {
  it('declares exactly the audits the script runs, in order', () => {
    const src = readFileSync(DAILY, 'utf8')
    const called = [...src.matchAll(/^audit_json (\w+)/gm)].map((m) => m[1])
    const declared = (src.match(/^AUDIT_EXPECTED='([^']+)'/m)?.[1] ?? '')
      .split(/\s+/)
      .filter(Boolean)

    expect(called.length).toBeGreaterThan(0)
    expect(declared).toEqual(called)
  })
})

describe('the standup reader degrades loudly, never silently', () => {
  const captureWarnings = (fn: () => unknown) => {
    const original = process.stderr.write.bind(process.stderr)
    let captured = ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stderr as any).write = (chunk: string) => {
      captured += chunk
      return true
    }
    try {
      return { result: fn(), captured }
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stderr as any).write = original
    }
  }

  it('does not throw on a truncated audits file', () => {
    const dir = makeTmpDir('audit-harness')
    const file = join(dir, 'estate-audits.json')
    // Byte-for-byte the shape of the real 129-byte casualty.
    writeFileSync(
      file,
      '{"collectedAt":"2026-08-04T03:41:16Z","audits":[{"name":"coverage","ok":true,"exit":0,"summary":"x"},',
    )

    const { result, captured } = captureWarnings(() => readAudits(file, '2026-08-04.json'))
    expect(result).toEqual([])
    expect(captured).toContain('not readable JSON')
    expect(captured).toContain('UNMEASURED, not clean')
  })

  /**
   * The worse of the two directions, and the estate's most-recorded defect: a
   * zero meaning "could not see the input" reading identically to one meaning
   * "nothing there". An absent audits file used to yield `[]` in silence, so
   * `buildFindings` could not raise `armingRegression` and a disarmed-hook
   * regression read exactly like an estate whose hooks are all armed.
   */
  it('warns rather than ranking a day with no audits at all', () => {
    const dir = makeTmpDir('audit-harness')
    const { result, captured } = captureWarnings(() =>
      readAudits(join(dir, 'estate-audits.json'), '2026-08-04.json'),
    )
    expect(result).toEqual([])
    expect(captured).toContain('no estate audits at')
  })

  it('warns when the audits are from a different day than the snapshot', () => {
    const dir = makeTmpDir('audit-harness')
    const file = join(dir, 'estate-audits.json')
    writeFileSync(
      file,
      JSON.stringify({
        collectedAt: '2026-08-03T03:40:00Z',
        audits: [{ name: 'coverage', ok: true }],
      }),
    )

    const { result, captured } = captureWarnings(() => readAudits(file, '2026-08-04.json'))
    expect(result).toHaveLength(1)
    expect(captured).toContain('audits are from 2026-08-03')
  })

  it('is quiet when the audits are current', () => {
    const dir = makeTmpDir('audit-harness')
    const file = join(dir, 'estate-audits.json')
    writeFileSync(
      file,
      JSON.stringify({
        collectedAt: '2026-08-04T03:40:00Z',
        audits: [{ name: 'coverage', ok: true }],
      }),
    )

    const { captured } = captureWarnings(() => readAudits(file, '2026-08-04.json'))
    expect(captured).toBe('')
  })
})
