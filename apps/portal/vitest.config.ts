import { existsSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * `src/instance-nav.ts` is optional (ADR-0028, as amended) — and this is the
 * THIRD resolver that has to know it.
 *
 * `tsconfig.json` handles `tsc`, `next.config.ts` handles the Next build, and
 * this handles vitest, which resolves `@` itself and never reads either. All
 * three must agree or the seam breaks in whichever one was forgotten: leaving
 * this out failed `nav.test.tsx` with *"Failed to resolve import
 * @/instance-nav"* while `tsc` and `next build` were both green.
 *
 * Ordered before the `@` prefix so the exact key wins.
 */
/**
 * Every optional instance-owned seam, as `specifier -> [instance file, default]`.
 *
 * Data rather than hand-written pairs because #1098 added a second seam and
 * immediately reproduced the failure this comment warns about: the new
 * specifier was declared in `tsconfig.json` and `next.config.ts` and forgotten
 * here, and vitest failed with *"Failed to resolve import
 * @/instance-login-destinations"* while both others were green.
 * `instance-seam-resolvers.test.ts` now asserts all three agree.
 */
const seams: Record<string, [string, string]> = {
  '@/instance-nav': ['./src/instance-nav.ts', './src/lib/instance-nav-empty.ts'],
  '@/instance-login-destinations': [
    './src/instance-login-destinations.ts',
    './src/lib/login-destinations-default.ts',
  ],
}

const seamAliases = Object.fromEntries(
  Object.entries(seams).map(([specifier, [instanceFile, fallback]]) => {
    const resolved = path.resolve(__dirname, instanceFile)
    return [specifier, existsSync(resolved) ? resolved : path.resolve(__dirname, fallback)]
  }),
)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      ...seamAliases,
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
  },
})
