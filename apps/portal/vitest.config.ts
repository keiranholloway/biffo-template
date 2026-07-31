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
const instanceNav = path.resolve(__dirname, './src/instance-nav.ts')
const navAlias = existsSync(instanceNav)
  ? instanceNav
  : path.resolve(__dirname, './src/lib/instance-nav-empty.ts')

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@/instance-nav': navAlias,
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
