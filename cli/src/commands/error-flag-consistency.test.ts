import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { MISSING_TEMPLATE_ROOT_GUIDANCE as DIFF_GUIDANCE, coreDiffCommand } from './core-diff.js'
import {
  MISSING_TEMPLATE_ROOT_GUIDANCE as UPGRADE_GUIDANCE,
  coreUpgradeCommand,
} from './core-upgrade.js'

/**
 * Regression guard for issue #324: a user-facing error string named a
 * `--template` flag that `core upgrade` does not have (its flag is
 * `--template-repo`), sending the user to a dead end. This asserts, for each
 * diagnostic string that names CLI flags, that every `--flag` it mentions is a
 * real long option on the command that emits it.
 *
 * To extend the guard to a new command, add its command object and the
 * flag-naming message here — that single registry is what keeps the class of
 * bug from recurring.
 */

/** Every long flag (`--foo`) a command declares in its own option set. */
function longFlags(command: Command): Set<string> {
  return new Set(
    command.options.map((o) => o.long).filter((l): l is string => typeof l === 'string'),
  )
}

/** Every `--flag` token named in a message, deduped. `--template-repo` matches
 * whole; `--template` inside it does not produce a spurious short token. */
function flagsNamed(message: string): string[] {
  return [...new Set([...message.matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0]))]
}

const cases: Array<{ name: string; command: Command; message: string }> = [
  {
    name: 'core upgrade — missing template root',
    command: coreUpgradeCommand,
    message: UPGRADE_GUIDANCE,
  },
  {
    name: 'core diff — missing template root',
    command: coreDiffCommand,
    message: DIFF_GUIDANCE,
  },
]

describe('user-facing error strings only name flags the command actually has', () => {
  for (const { name, command, message } of cases) {
    it(`${name}: every flag it names is a real option`, () => {
      const named = flagsNamed(message)
      // Guard the guard: a message registered here is expected to name a flag.
      expect(named.length).toBeGreaterThan(0)
      const real = longFlags(command)
      for (const flag of named) {
        expect(
          real.has(flag),
          `"${name}" names ${flag}, which is not an option on this command. ` +
            `Real options: ${[...real].sort().join(', ')}`,
        ).toBe(true)
      }
    })
  }

  it('core upgrade names --template-repo, its canonical flag (regression: #324)', () => {
    expect(UPGRADE_GUIDANCE).toContain('--template-repo')
    expect(longFlags(coreUpgradeCommand).has('--template-repo')).toBe(true)
    // The original #324 bug: the message named a bare --template, which this
    // command did not have at the time. The guidance still names only the
    // fully-descriptive canonical spelling, --template-repo.
    expect(flagsNamed(UPGRADE_GUIDANCE)).not.toContain('--template')
  })

  it('core upgrade also accepts --template, as a real alias for --template-repo (#1138)', () => {
    // Unlike #324 — where --template named in a message was a dead end because
    // the command had no such option — this is now a genuine, working option:
    // `core diff` and `core upgrade` used to name the same argument
    // differently, so the natural preview-then-apply workflow failed on the
    // second command with the flag that had just worked on the first.
    expect(longFlags(coreUpgradeCommand).has('--template')).toBe(true)
  })
})
