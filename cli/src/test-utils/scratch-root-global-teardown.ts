import { markRunComplete } from './scratch-root.js'

/**
 * `vitest.config.ts` stashes this run's scratch directory (`runDir`) here
 * before `defineConfig` returns. Vitest's `globalSetup` files execute once,
 * in the same main-thread process that evaluated the config, before any
 * worker spawns -- so the same `process.env` set synchronously there is
 * still readable from this file's `teardown` once it fires (#1864).
 */
export const RUN_DIR_ENV = '__BIFFO_TEST_SCRATCH_RUN_DIR'

/**
 * Vitest `test.globalSetup` entry point: a default-exported `setup` that
 * returns a `teardown`, called once after every test file in this
 * invocation has finished -- not per test file, and not called at all if the
 * process is killed or crashes rather than exiting normally (see
 * `scratch-root.ts`'s doc comment for why that distinction is load-bearing).
 */
export default function setup(): () => void {
  return function teardown(): void {
    const runDir = process.env[RUN_DIR_ENV]
    if (runDir) markRunComplete(runDir)
  }
}
