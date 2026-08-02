/**
 * A failed collection must announce itself on the artefact people actually look
 * at.
 *
 * On 2026-08-02 the collector died at 04:30 and the only record was a line in
 * `~/.practices-daily.log`. The outage was found at 05:11 because a human
 * happened to run the standup; three quiet days would have been three days dark,
 * and the bookmarked dashboard would have gone on showing stale numbers with
 * nothing marking them stale.
 *
 * The `notify-send` path is best-effort by nature (no desktop session, no
 * notification). The banner is not, so it is what these tests pin. They execute
 * the real trap functions lifted out of `practices-daily.sh` rather than
 * asserting on its source text — a substring guard would pass against a script
 * that never runs them.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(repoRoot, 'scripts/practices-daily.sh')

/** The trap machinery, extracted so it can be driven without a 5-minute run. */
let harness = ''

beforeAll(() => {
  const src = readFileSync(SCRIPT, 'utf8')
  const grab = (name: string) => {
    const start = src.indexOf(`${name}() {`)
    if (start === -1) throw new Error(`${name} not found in practices-daily.sh`)
    const end = src.indexOf('\n}\n', start)
    return src.slice(start, end + 3)
  }
  harness = `set -euo pipefail\n${grab('_notify')}\n${grab('_stamp_stale')}\n${grab('_finish')}\ntrap _finish EXIT\n`
})

interface Result {
  page: string
  strays: number
}

/** Run `n` aborting "collections" against a throwaway dashboard file. */
function abortRuns(
  n: number,
  initialPage = '<html><body><h1>Dashboard</h1></body></html>\n',
): Result {
  const dir = mkdtempSync(join(tmpdir(), 'practices-alert-'))
  try {
    const page = join(dir, 'dashboard.html')
    writeFileSync(page, initialPage)
    const script = join(dir, 'run.sh')
    writeFileSync(script, `${harness}false\n`)
    for (let i = 0; i < n; i++) {
      try {
        execFileSync('bash', [script], {
          cwd: dir,
          stdio: 'pipe',
          // No session bus: this is what cron looks like, and the notify path
          // must degrade to nothing rather than taking the trap down with it.
          env: { ...process.env, PRACTICES_PAGE: page, DBUS_SESSION_BUS_ADDRESS: '' },
        })
      } catch {
        /* the run is meant to fail; the trap is what is under test */
      }
    }
    return {
      page: readFileSync(page, 'utf8'),
      strays: readdirSync(dir).filter((f) => f.includes('.tmp.')).length,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('a failed collection marks the dashboard stale', () => {
  it('stamps a banner saying the numbers are not today’s', () => {
    const { page } = abortRuns(1)

    expect(page).toContain('COLLECTION FAILED')
    expect(page).toContain('STALE')
  })

  it('keeps the last good content rather than blanking it', () => {
    // Blanking would trade a silent wrong answer for no answer. The previous
    // numbers stay useful so long as nobody mistakes them for today's.
    expect(abortRuns(1).page).toContain('<h1>Dashboard</h1>')
  })

  it('leaves ONE banner after repeated failures, not a stack', () => {
    const { page } = abortRuns(3)

    expect(page.split('practices-stale').length - 1).toBe(1)
  })

  it('does not litter temp files', () => {
    expect(abortRuns(2).strays).toBe(0)
  })

  it('survives having no dashboard to stamp', () => {
    // First-ever run, or a cleared home directory. Must not turn a collection
    // failure into a trap failure that hides it.
    const dir = mkdtempSync(join(tmpdir(), 'practices-alert-'))
    try {
      const script = join(dir, 'run.sh')
      writeFileSync(script, `${harness}false\n`)
      let stderr = ''
      try {
        execFileSync('bash', [script], {
          cwd: dir,
          stdio: 'pipe',
          env: {
            ...process.env,
            PRACTICES_PAGE: join(dir, 'absent.html'),
            DBUS_SESSION_BUS_ADDRESS: '',
          },
        })
      } catch (err) {
        stderr = String((err as { stderr?: Buffer }).stderr ?? '')
      }
      expect(stderr).toContain('ABORTED')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the notification path is reachable from cron', () => {
  it('does not gate on an inherited DBUS_SESSION_BUS_ADDRESS', () => {
    // The three calls this replaced were guarded on that variable being set,
    // which under cron it never is: the crontab exports PATH and nothing else.
    // So the estate-audit alert existed, read as coverage, and had never fired.
    const src = readFileSync(SCRIPT, 'utf8')
    const notify = src.slice(
      src.indexOf('_notify() {'),
      src.indexOf('\n}\n', src.indexOf('_notify() {')),
    )

    expect(notify).toContain('/run/user/')

    // No remaining caller may re-introduce the guard that made this dead --
    // asserted over CODE only. The first version of this check matched the
    // whole file and failed on the comment that *documents* the old guard,
    // which is the substring-guard mistake #957 exists to stop: a test that
    // cannot tell an occurrence from a description of one.
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')

    expect(code).not.toContain('[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]')
  })
})
