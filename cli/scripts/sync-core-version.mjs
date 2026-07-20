#!/usr/bin/env node
/**
 * Copy the template's root `core.version` into the CLI package directory.
 *
 * Why this exists: `getLatestCoreVersion()` (cli/src/lib/core-version.ts)
 * resolves the core version this CLI ships with by walking UP from the module's
 * own location to the nearest `core.version`. Inside the template checkout that
 * walk lands on the repo root. Once the CLI is installed from npm as `biffo`,
 * there is nothing above `node_modules/biffo/dist/` to find, and `biffo core
 * status` would fail with "This CLI build is missing its core version".
 *
 * The fix keeps the resolution logic untouched: put a copy of `core.version`
 * next to `dist/` inside the package and list it in package.json `files`, so
 * the existing upward walk finds it one level up from `dist/`.
 *
 * It is run from `prepack` (which npm/pnpm invoke for both `npm pack` and
 * `npm publish`) and removed again by `postpack`, after the tarball has been
 * written. Deliberately NOT run as part of `build`: a copy left lying around in
 * a developer checkout would shadow the repo-root file and silently report a
 * stale "latest" version after someone bumps `core.version` without rebuilding
 * — precisely the class of silent staleness issue #190 is about.
 *
 * Usage: node scripts/sync-core-version.mjs [destDir]   (default: the package root)
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEMVER = /^\d+\.\d+\.\d+$/

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const source = resolve(packageRoot, '..', 'core.version')
const destDir = process.argv[2] ? resolve(process.argv[2]) : packageRoot
const dest = join(destDir, 'core.version')

if (!existsSync(source)) {
  console.error(`sync-core-version: no core.version at ${source}.`)
  console.error('The CLI package must be packed from inside the template checkout.')
  process.exit(1)
}

const version = readFileSync(source, 'utf8').trim()
if (!SEMVER.test(version)) {
  console.error(`sync-core-version: ${source} is not a semver: ${JSON.stringify(version)}`)
  process.exit(1)
}

copyFileSync(source, dest)
// stderr, not stdout: this runs as `prepack`, so anything it writes to stdout is
// captured by `npm pack`'s caller as part of the tarball filename. That broke the
// publish workflow's verification step — tar was handed
// "sync-core-version: /path/core.version <- 0.33.1\nbiffo-0.33.1.tgz" as a
// filename and failed. Progress output is diagnostics, not data.
console.error(`sync-core-version: ${dest} <- ${version}`)
