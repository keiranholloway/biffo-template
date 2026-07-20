#!/usr/bin/env node
/**
 * Copy the repo-root assets listed in `packaged-root-assets.mjs` into the CLI
 * package directory, so the published tarball carries them.
 *
 * Why this exists: several CLI modules resolve a companion asset by walking UP
 * from their own location to the nearest match (`core.version` for
 * `getLatestCoreVersion()`, `_skeletons/` for `biffo init` / `sibling create` /
 * `plugin create`). Inside the template checkout that walk lands on the repo
 * root. Once installed from npm there is nothing above
 * `node_modules/@biffo/cli/dist/`, so the package must ship its own copies.
 *
 * The fix keeps every resolver untouched: put the copies next to `dist/` inside
 * the package and list them in package.json `files`, so the existing upward walk
 * finds them one level up from `dist/`. See `packaged-root-assets.mjs` for the
 * inventory and the two incidents (#259, #315) that produced it.
 *
 * Run from `prepack` (which npm/pnpm invoke for both `npm pack` and `npm
 * publish`) and undone by `postpack` once the tarball is written. Deliberately
 * NOT part of `build`: copies left lying around in a developer checkout would
 * shadow the repo-root originals and silently serve stale content — precisely
 * the class of silent staleness issue #190 is about.
 *
 * Usage:
 *   node scripts/sync-packaged-assets.mjs [destDir]    copy in   (default: package root)
 *   node scripts/sync-packaged-assets.mjs --clean [destDir]   remove the copies
 */
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGED_ROOT_ASSETS } from './packaged-root-assets.mjs'

const SEMVER = /^\d+\.\d+\.\d+$/

/**
 * npm drops `.gitignore` from every tarball — at any depth, unconditionally, and
 * an explicit `files` entry does NOT override it (verified with `npm pack`).
 *
 * The skeletons' `.gitignore` is shipped *content*: it becomes the scaffolded
 * repo's own `.gitignore`. Losing it would leave `biffo init` producing a repo
 * that looks fine while committing node_modules/, .terraform/, .env and tfstate
 * — a silent failure, worse than the loud one in #315.
 *
 * So the packaged copy stores it as `_gitignore`, and the scaffolders rename it
 * back (`cli/src/lib/skeleton-dotfiles.ts`). The repo-root skeleton is untouched.
 */
const PACKAGED_GITIGNORE = '_gitignore'

function hideGitignoresFromNpm(dir) {
  const renamed = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      renamed.push(...hideGitignoresFromNpm(full))
    } else if (entry.name === '.gitignore') {
      renameSync(full, join(dir, PACKAGED_GITIGNORE))
      renamed.push(full)
    }
  }
  return renamed
}

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const repoRoot = resolve(packageRoot, '..')

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const positional = args.filter((a) => !a.startsWith('--'))
const destDir = positional[0] ? resolve(positional[0]) : packageRoot

const fail = (message) => {
  console.error(`sync-packaged-assets: ${message}`)
  process.exit(1)
}

for (const asset of PACKAGED_ROOT_ASSETS) {
  const dest = join(destDir, asset.path)

  if (clean) {
    rmSync(dest, { recursive: true, force: true })
    continue
  }

  const source = join(repoRoot, asset.path)
  if (!existsSync(source)) {
    console.error(`sync-packaged-assets: no ${asset.path} at ${source}.`)
    fail('The CLI package must be packed from inside the template checkout.')
  }

  // Never copy onto a stale leftover — a previous pack could have left an older
  // tree behind, and cpSync merges rather than replaces.
  rmSync(dest, { recursive: true, force: true })
  cpSync(source, dest, { recursive: asset.kind === 'dir' })

  if (asset.kind === 'dir') {
    for (const path of hideGitignoresFromNpm(dest)) {
      console.error(`sync-packaged-assets: ${path} -> ${PACKAGED_GITIGNORE} (npm strips .gitignore)`)
    }
  }

  // Prove the copy is complete rather than an empty directory: an empty
  // `_skeletons/` would ship, satisfy a naive "is it in the tarball" check, and
  // still fail at `biffo init` step 6/6.
  const sentinel = join(destDir, asset.sentinel)
  if (!existsSync(sentinel)) {
    fail(`copied ${asset.path} but ${asset.sentinel} is missing — the copy is incomplete.`)
  }

  if (asset.path === 'core.version') {
    const version = readFileSync(dest, 'utf8').trim()
    if (!SEMVER.test(version)) {
      fail(`${source} is not a semver: ${JSON.stringify(version)}`)
    }
  }

  // stderr, not stdout: this runs as `prepack`, so anything written to stdout is
  // captured by `npm pack`'s caller as part of the tarball filename. That broke
  // the publish workflow's verification step once already — tar was handed
  // "sync-core-version: /path/core.version <- 0.33.1\nbiffo-0.33.1.tgz" as a
  // filename and failed. Progress output is diagnostics, not data.
  console.error(`sync-packaged-assets: ${dest} <- ${source}`)
}
