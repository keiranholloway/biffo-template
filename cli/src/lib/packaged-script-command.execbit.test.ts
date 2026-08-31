import { chmodSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runPackagedScript } from './packaged-script-command.js'

/**
 * #1723's bare-exec dispatch (`spawnSync(script, args, ...)`, no shell, no
 * forced interpreter) depends on the kernel being ALLOWED to exec the
 * script, which needs the executable bit set — the exact thing this repo's
 * own dispatch table got wrong for `scripts/pgtest-diff-check.sh`, tracked
 * `100644` and missed by the first pass over the other nine scripts this
 * factory dispatches. That would have failed every `biffo pgtest-diff-check`
 * invocation with an opaque `EACCES` (mapped to exit 2, indistinguishable
 * from the scripts' own "cannot tell" convention) the moment bare-exec
 * dispatch shipped.
 *
 * Fixing the one tracked mode bit closes today's instance; it does not close
 * the CLASS, because the next script added to this factory can just as
 * easily arrive without `chmod +x` (in git, or lose it some other way on
 * disk) with nothing to catch it before a user does. `runPackagedScript`
 * self-heals instead: it checks the script's mode before spawning and adds
 * the executable bits if missing. This test proves that directly, with a
 * REAL (unmocked) `spawnSync`, `statSync` and `chmodSync` — a mocked
 * `child_process` (as `packaged-script-command.test.ts` uses for its
 * argument-shape assertions) cannot observe a real EACCES or a real mode
 * change, only that spawnSync was "called with" some arguments.
 */
describe('runPackagedScript self-heals a missing executable bit (#1723)', () => {
  it('runs a script that lost its executable bit, rather than failing EACCES on a stale mode', () => {
    const dir = makeTmpDir('biffo-execbit-repro')
    const script = join(dir, 'noexec.sh')
    // Simulate scripts/pgtest-diff-check.sh's tracked mode (100644) before
    // this fix: content and shebang are fine, only the executable bit is
    // missing.
    writeFileSync(script, '#!/usr/bin/env sh\necho ran\n')
    chmodSync(script, 0o644)
    expect(statSync(script).mode & 0o111).toBe(0)

    const status = runPackagedScript(script, [], dir)

    expect(status).toBe(0)
    expect(statSync(script).mode & 0o111).not.toBe(0)
  })

  it('leaves an already-executable script alone rather than fighting a deliberate mode', () => {
    const dir = makeTmpDir('biffo-execbit-noop')
    const script = join(dir, 'exec.sh')
    writeFileSync(script, '#!/usr/bin/env sh\necho ran\n')
    chmodSync(script, 0o750)

    const status = runPackagedScript(script, [], dir)

    expect(status).toBe(0)
    // Still runnable by owner/group only — the fix adds the missing bit, it
    // does not widen an existing one to 0o755.
    expect(statSync(script).mode & 0o007).toBe(0)
  })
})
