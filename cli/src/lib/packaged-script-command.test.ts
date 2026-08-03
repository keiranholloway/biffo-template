import { spawnSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { interpreterFor, runPackagedScript } from './packaged-script-command.js'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
const spawnSyncMock = vi.mocked(spawnSync)

/**
 * #1240: `packagedScriptCommand` spawned every script with `sh`, which cannot
 * run `scripts/runner-drop-forensics.mjs` (#1238) — the fix a satellite most
 * needs, since 17 of the 22 runner-killed jobs the tool was validated against
 * happened in satellites, and only 5 in repos that carry the script directly.
 *
 * These test `interpreterFor` and `runPackagedScript` directly rather than
 * driving the whole `Command` through commander: the action reads its
 * arguments off `process.argv` itself (see the comment in
 * `packaged-script-command.ts`), so simulating commander's own parsing would
 * prove nothing beyond "commander still parses" and miss the actual dispatch
 * logic this issue is about.
 */
describe('interpreterFor', () => {
  it('picks sh for .sh scripts, unchanged — six commands depend on this today', () => {
    expect(interpreterFor('scripts/branch-health.sh')).toBe('sh')
    expect(interpreterFor('scripts/claim.sh')).toBe('sh')
  })

  it('picks node for .mjs scripts, since sh cannot execute one (#1240)', () => {
    expect(interpreterFor('scripts/runner-drop-forensics.mjs')).toBe('node')
  })
})

describe('runPackagedScript', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset()
  })

  it.each([
    ['scripts/branch-health.sh', 'sh'],
    ['scripts/runner-drop-forensics.mjs', 'node'],
  ])('spawns %s under %s, forwarding args and the caller cwd', (script, interpreter) => {
    spawnSyncMock.mockReturnValue({ status: 0 } as unknown as ReturnType<typeof spawnSync>)

    runPackagedScript(script, ['--repo', 'acme/widgets', '--run', '123'], '/caller/original/cwd')

    expect(spawnSyncMock).toHaveBeenCalledWith(
      interpreter,
      [script, '--repo', 'acme/widgets', '--run', '123'],
      { stdio: 'inherit', cwd: '/caller/original/cwd' },
    )
  })

  it.each([
    ['scripts/branch-health.sh', 0],
    ['scripts/branch-health.sh', 1],
    ['scripts/runner-drop-forensics.mjs', 0],
    ['scripts/runner-drop-forensics.mjs', 1],
  ])('%s passes a %i exit code through unchanged, for both interpreters', (script, status) => {
    spawnSyncMock.mockReturnValue({ status } as unknown as ReturnType<typeof spawnSync>)
    expect(runPackagedScript(script, [], '/x')).toBe(status)
  })

  it.each(['scripts/branch-health.sh', 'scripts/runner-drop-forensics.mjs'])(
    '%s maps a signal-killed child (null status) to 2, never a pass, under either interpreter',
    (script) => {
      spawnSyncMock.mockReturnValue({ status: null } as unknown as ReturnType<typeof spawnSync>)
      expect(runPackagedScript(script, [], '/x')).toBe(2)
    },
  )
})
