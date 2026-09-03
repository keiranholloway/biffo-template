import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import setup, { RUN_DIR_ENV } from './scratch-root-global-teardown.js'
import { COMPLETION_MARKER } from './scratch-root.js'
import { makeTmpDir } from './tmp.js'

describe('scratch-root-global-teardown', () => {
  const originalEnv = process.env[RUN_DIR_ENV]

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[RUN_DIR_ENV]
    else process.env[RUN_DIR_ENV] = originalEnv
  })

  it('marks the run directory named by RUN_DIR_ENV complete once teardown fires', () => {
    const runDir = makeTmpDir('global-teardown-mark')
    process.env[RUN_DIR_ENV] = runDir

    const teardown = setup()
    expect(existsSync(join(runDir, COMPLETION_MARKER))).toBe(false) // not yet -- setup() only registers it

    teardown()

    expect(existsSync(join(runDir, COMPLETION_MARKER))).toBe(true)
  })

  it('does nothing when RUN_DIR_ENV was never set -- must not crash a run missing it', () => {
    delete process.env[RUN_DIR_ENV]
    const teardown = setup()
    expect(() => teardown()).not.toThrow()
  })
})
