import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Served by the shared plugin host at /api/v1/plugins/example-plugin/ui/*
// (docs/guides/plugins.md's "User-facing frontend" section, ADR-0021 §2) —
// UNAUTHENTICATED, unlike web-admin's sibling: a plain browser navigation can
// never attach a bearer token, so this shell is served with no group_gate at
// all (services/_plugin-host/src/plugin_host/mount.py). Every asset/link URL
// must carry the full prefix, INCLUDING THIS PLUGIN'S OWN NAME. `biffo plugin
// create` rewrites `example-plugin` to the real slug (see
// .scaffold-tokens.json); do not hand-edit this after scaffolding without
// updating BOTH this file and base-path.test.ts.
//
// Mirrors web-admin/vite.config.ts's own comment almost verbatim, because the
// trap it describes is identical here: idea-scout's copy of THAT file was
// pasted from ideation's and kept ideation's base, and no local gate caught
// it — lint, typecheck, unit tests and the production build all passed,
// because `base` only affects the URLs inside the emitted HTML. It was only
// visible by loading the page and reading the network log. Hence the full
// path, and hence base-path.test.ts asserting it stays correct.
export default defineConfig({
  base: '/api/v1/plugins/example-plugin/ui/',
  plugins: [react()],
  build: { outDir: 'dist' },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'] },
})
