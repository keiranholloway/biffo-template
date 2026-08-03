import 'aws-sdk-client-mock-vitest/extend'
import {
  toHaveReceivedCommand,
  toHaveReceivedCommandWith,
  toHaveReceivedNthCommandWith,
} from 'aws-sdk-client-mock-vitest'
import { afterAll, expect } from 'vitest'
import { sweepTmpDirs } from './test-utils/tmp.js'

expect.extend({ toHaveReceivedCommand, toHaveReceivedCommandWith, toHaveReceivedNthCommandWith })

// #1197: with `isolate: true` (vitest's default) this setup file runs once
// per test file, so this `afterAll` runs after all of that file's tests
// finish — catching directories made in a `beforeAll`, inside a nested
// helper, or by a test that failed before it could clean up after itself.
afterAll(() => {
  sweepTmpDirs()
})
