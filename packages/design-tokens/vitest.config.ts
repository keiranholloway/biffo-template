import { defineConfig } from 'vitest/config'

// Bounded workers + pre-push-only retry: see apps/portal/vitest.config.ts.
export default defineConfig({
  test: {
    maxWorkers: 2,
    retry: process.env.BIFFO_PRE_PUSH ? 1 : 0,
  },
})
