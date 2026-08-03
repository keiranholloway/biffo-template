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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

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
  // `_stamp_stale` and `_finish` both read `$PRACTICES_LOG` (#1126) rather than
  // the string it used to hardcode, and that assignment lives at top level, not
  // inside either function -- `grab()` only lifts function bodies, so without
  // this line the harness ran `set -u` against a variable nothing had ever set,
  // and the trap aborted mid-`_stamp_stale` before writing the banner it was
  // meant to prove. Deliberately NOT pulling in the `exec > >(tee ...) 2>&1`
  // line a few lines below it: that redirects the running script's own stderr
  // into the tee pipe, which would starve the "stderr contains ABORTED" test
  // below of anything to read on the child process's fd 2.
  const logAssignment = src.match(/^PRACTICES_LOG=.*$/m)?.[0]
  if (!logAssignment) throw new Error('PRACTICES_LOG assignment not found in practices-daily.sh')
  harness = `set -euo pipefail\n${logAssignment}\n${grab('_notify')}\n${grab('_stamp_stale')}\n${grab('_finish')}\ntrap _finish EXIT\n`
})

interface Result {
  page: string
  strays: number
  /** One entry per `notify-send` the run actually invoked, argv joined. */
  notifications: string[]
}

/**
 * A fake `notify-send`, first on PATH.
 *
 * This is the whole reason the file was revised. These tests used to blank
 * `DBUS_SESSION_BUS_ADDRESS` to "simulate cron" and then call the real binary —
 * but an empty bus address is exactly the case `_notify` reconstructs from
 * /run/user/<uid>/bus, so on any developer workstation the suite fired eight
 * genuine `-u critical` desktop notifications per run, none of which expire.
 * A day of `pnpm test` buried the machine, and the alert people then learned to
 * dismiss was the same one a real 04:30 outage would use.
 *
 * Stubbing also turns the notification from an invisible side effect into an
 * assertable one, which is what lets the replace-don't-stack test below exist.
 * It emulates the two libnotify flags `_notify` depends on: `--print-id` writes
 * an id to stdout, and `--replace-id` is recorded so a test can prove the second
 * alert reuses the first one's id rather than opening another card.
 */
const STUB_ID = '4242'
function installNotifyStub(dir: string): { bin: string; log: string } {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'notify-calls.log')
  writeFileSync(
    join(bin, 'notify-send'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >>"${log}"\necho ${STUB_ID}\n`,
    { mode: 0o755 },
  )
  return { bin, log }
}

/** Run `n` aborting "collections" against a throwaway dashboard file. */
function abortRuns(
  n: number,
  initialPage = '<html><body><h1>Dashboard</h1></body></html>\n',
  extraEnv: Record<string, string> = {},
): Result {
  const dir = makeTmpDir('practices-alert')
  try {
    const page = join(dir, 'dashboard.html')
    writeFileSync(page, initialPage)
    const script = join(dir, 'run.sh')
    writeFileSync(script, `${harness}false\n`)
    const { bin, log } = installNotifyStub(dir)
    for (let i = 0; i < n; i++) {
      try {
        execFileSync('bash', [script], {
          cwd: dir,
          stdio: 'pipe',
          env: {
            ...process.env,
            PRACTICES_PAGE: page,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            // Non-empty, so `_notify` takes the inherited-address path and never
            // probes the real session socket. Blanking it here is what made the
            // suite spam the developer's desktop; the cron reconstruction is
            // covered separately, below, without executing it.
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null',
            // Each run gets its own id file, so "did the second call reuse the
            // first id?" is a question about this test and not about whatever
            // the real collector last wrote into the session runtime dir.
            XDG_RUNTIME_DIR: dir,
            ...extraEnv,
          },
        })
      } catch {
        /* the run is meant to fail; the trap is what is under test */
      }
    }
    return {
      page: readFileSync(page, 'utf8'),
      strays: readdirSync(dir).filter((f) => f.includes('.tmp.')).length,
      notifications: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
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
    const dir = makeTmpDir('practices-alert')
    try {
      const script = join(dir, 'run.sh')
      writeFileSync(script, `${harness}false\n`)
      const { bin } = installNotifyStub(dir)
      let stderr = ''
      try {
        execFileSync('bash', [script], {
          cwd: dir,
          stdio: 'pipe',
          env: {
            ...process.env,
            PRACTICES_PAGE: join(dir, 'absent.html'),
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null',
            XDG_RUNTIME_DIR: dir,
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

describe('the alert interrupts once, not once per failure', () => {
  it('replaces the previous card instead of stacking a new one', () => {
    // `-u critical` never auto-expires in GNOME. Without --replace-id, three
    // dark days leave three identical permanent cards, and the pile is what
    // trains someone to dismiss the alert that actually matters.
    const { notifications } = abortRuns(3)

    expect(notifications).toHaveLength(3)
    // First run has no id on file yet, so it opens a card...
    expect(notifications[0]).toContain('-r 0')
    // ...and every later one reuses the id the stub handed back.
    expect(notifications[1]).toContain(`-r ${STUB_ID}`)
    expect(notifications[2]).toContain(`-r ${STUB_ID}`)
  })

  it('still asks for --print-id so there is an id to reuse', () => {
    expect(abortRuns(1).notifications[0]).toContain('-p')
  })

  it('keeps alerting when libnotify is too old for those flags', () => {
    // Fail-open: a notification that stacks is worth more than one that never
    // appears. This is the shape of the bug the function's own comment records
    // -- a guard that reads as coverage and silently suppresses the alert.
    const dir = makeTmpDir('practices-alert')
    try {
      const page = join(dir, 'dashboard.html')
      writeFileSync(page, '<html><body><h1>Dashboard</h1></body></html>\n')
      const script = join(dir, 'run.sh')
      writeFileSync(script, `${harness}false\n`)
      const bin = join(dir, 'bin')
      mkdirSync(bin, { recursive: true })
      const log = join(dir, 'legacy.log')
      // Rejects -p/-r the way a pre-0.7.7 notify-send does, accepts the plain form.
      writeFileSync(
        join(bin, 'notify-send'),
        `#!/bin/sh\ncase "$*" in *-p*) exit 1 ;; esac\nprintf '%s\\n' "$*" >>"${log}"\n`,
        { mode: 0o755 },
      )
      try {
        execFileSync('bash', [script], {
          cwd: dir,
          stdio: 'pipe',
          env: {
            ...process.env,
            PRACTICES_PAGE: page,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null',
            XDG_RUNTIME_DIR: dir,
          },
        })
      } catch {
        /* the run is meant to fail */
      }
      expect(existsSync(log)).toBe(true)
      expect(readFileSync(log, 'utf8')).toContain('Practices collection FAILED')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a driven run can decline to alert a human', () => {
  it('sends nothing when PRACTICES_NO_DESKTOP_ALERT is set', () => {
    const { notifications } = abortRuns(3, undefined, { PRACTICES_NO_DESKTOP_ALERT: '1' })

    expect(notifications).toEqual([])
  })

  it('still stamps the dashboard when the desktop alert is suppressed', () => {
    // Suppression must silence the interruption, never the record. The banner
    // is the artefact people actually look at; muting it would restore the
    // silent-stale-numbers failure this whole file exists to prevent.
    const { page } = abortRuns(1, undefined, { PRACTICES_NO_DESKTOP_ALERT: '1' })

    expect(page).toContain('COLLECTION FAILED')
    expect(page).toContain('STALE')
  })

  it('does not suppress on an empty value, which is how cron looks', () => {
    // `env -u` and an unset variable both arrive as ''. Treating that as "be
    // quiet" would silently disarm the 04:30 alert.
    const { notifications } = abortRuns(1, undefined, { PRACTICES_NO_DESKTOP_ALERT: '' })

    expect(notifications).toHaveLength(1)
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
