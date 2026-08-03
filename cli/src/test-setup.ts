import 'aws-sdk-client-mock-vitest/extend'
import {
  toHaveReceivedCommand,
  toHaveReceivedCommandWith,
  toHaveReceivedNthCommandWith,
} from 'aws-sdk-client-mock-vitest'
import { afterAll, expect } from 'vitest'
import { installTestEnvSandbox } from './test-utils/env-sandbox.js'
import { sweepTmpDirs } from './test-utils/tmp.js'

expect.extend({ toHaveReceivedCommand, toHaveReceivedCommandWith, toHaveReceivedNthCommandWith })

// #1125: any test that shells out inherits process.env/PATH by default, which
// is also a live channel to the developer's real D-Bus session, desktop
// notifications, and anything else keyed off these variables. Runs before any
// test in this file, so reaching the real session becomes opt-in rather than
// the default. See test-utils/env-sandbox.ts for the full rationale and the
// documented opt-in.
installTestEnvSandbox()

// #1197: with `isolate: true` (vitest's default) this setup file runs once
// per test file, so this `afterAll` runs after all of that file's tests
// finish — catching directories made in a `beforeAll`, inside a nested
// helper, or by a test that failed before it could clean up after itself.
afterAll(() => {
  sweepTmpDirs()
})
