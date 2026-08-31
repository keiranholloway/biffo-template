import { spawnSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runPackagedScript } from './packaged-script-command.js'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
const spawnSyncMock = vi.mocked(spawnSync)

/**
 * #1240: `packagedScriptCommand` used to spawn every script with a hardcoded
 * `sh` (or `node` for `.mjs`, added for `scripts/runner-drop-forensics.mjs`).
 * #1723: that hardcoding is the defect one level deeper than #1709 — three of
 * the `sh`-forced scripts (`branch-health.sh`, `gate-coverage.sh`,
 * `hook-audit.sh`) declare `#!/usr/bin/env bash` and need it, for `set -uo
 * pipefail`. Forcing them through `sh` discards that shebang and hands them
 * to dash, which some builds (the GitHub-hosted runner's) reject the
 * `pipefail` option on at RUNTIME — not a syntax error, so no static check
 * catches it, and the resulting exit 2 is indistinguishable from these
 * scripts' own deliberate "cannot tell" convention.
 *
 * The fix drops the hardcoded interpreter entirely: `runPackagedScript` now
 * spawns the script as a bare executable path and lets the kernel dispatch
 * per its own shebang, for `.sh` and `.mjs` alike.
 *
 * These test `runPackagedScript` directly rather than driving the whole
 * `Command` through commander: the action reads its arguments off
 * `process.argv` itself (see the comment in `packaged-script-command.ts`), so
 * simulating commander's own parsing would prove nothing beyond "commander
 * still parses" and miss the actual dispatch logic this issue is about.
 */
describe('runPackagedScript', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset()
  })

  it.each(['scripts/branch-health.sh', 'scripts/runner-drop-forensics.mjs', 'scripts/claim.sh'])(
    'spawns %s as a bare executable path, not through a hardcoded interpreter, forwarding args and the caller cwd',
    (script) => {
      spawnSyncMock.mockReturnValue({ status: 0 } as unknown as ReturnType<typeof spawnSync>)

      runPackagedScript(script, ['--repo', 'acme/widgets', '--run', '123'], '/caller/original/cwd')

      expect(spawnSyncMock).toHaveBeenCalledWith(
        script,
        ['--repo', 'acme/widgets', '--run', '123'],
        { stdio: 'inherit', cwd: '/caller/original/cwd' },
      )
    },
  )

  it.each([
    ['scripts/branch-health.sh', 0],
    ['scripts/branch-health.sh', 1],
    ['scripts/runner-drop-forensics.mjs', 0],
    ['scripts/runner-drop-forensics.mjs', 1],
  ])('%s passes a %i exit code through unchanged', (script, status) => {
    spawnSyncMock.mockReturnValue({ status } as unknown as ReturnType<typeof spawnSync>)
    expect(runPackagedScript(script, [], '/x')).toBe(status)
  })

  it.each(['scripts/branch-health.sh', 'scripts/runner-drop-forensics.mjs'])(
    '%s maps a signal-killed child (null status) to 2, never a pass',
    (script) => {
      spawnSyncMock.mockReturnValue({ status: null } as unknown as ReturnType<typeof spawnSync>)
      expect(runPackagedScript(script, [], '/x')).toBe(2)
    },
  )
})
