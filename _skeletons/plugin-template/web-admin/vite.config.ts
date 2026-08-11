import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Served by the shared plugin host at /api/v1/plugins/example-plugin/admin/*
// (the API Gateway path, not a separate CloudFront/S3 origin the way the
// founder-facing web/ app is) — every asset/link URL must carry that full
// prefix, INCLUDING THIS PLUGIN'S OWN NAME. `biffo plugin create` rewrites
// `example-plugin` to the real slug (see .scaffold-tokens.json); do not hand-edit
// this after scaffolding without updating BOTH this file and base-path.test.ts.
//
// This is not a theoretical trap. idea-scout's copy of this file was pasted
// from ideation's and kept ideation's base. The built index.html then requested
// idea-scout's own asset filenames under ideation's path — 503, blank page, and
// NOT ONE local gate caught it: lint, typecheck, unit tests and the production
// build all passed, because `base` only affects the URLs inside the emitted
// HTML. It was visible solely by loading the page and reading the network log.
//
// The neighbouring trap: with a short base like "/example-plugin/admin/",
// CloudFront's 404->index.html rule papers the miss over as a 200 serving the
// PORTAL's homepage, so the browser tries to parse HTML as JS. Both failure
// modes are silent in different ways — hence the full path, and hence
// base-path.test.ts asserting it stays correct rather than trusting eyes alone.
export default defineConfig({
  base: '/api/v1/plugins/example-plugin/admin/',
  plugins: [react()],
  build: { outDir: 'dist' },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'] },
})
