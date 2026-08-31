#!/usr/bin/env node
/**
 * CLI runner for the general plan-time-build-artifact collector (#1663,
 * biffo-template#1772). See `plan-build-artifacts.mjs` for why this exists
 * and where the values come from.
 *
 * Prints one repo-root-relative path per line, for every `archive_file`
 * `output_path` the plan resolved that (a) actually exists on disk right now
 * -- an unresolved, apply-deferred data source has nothing to transport --
 * and (b) resolves inside the repo checkout, so it is safe to restore
 * relative to `$GITHUB_WORKSPACE` on the apply runner.
 *
 * Deliberately EXCLUDES anything already under `<tf-working-dir>/.build/` --
 * `deploy-infra.yml`'s `tfbuild-<env>` steps already transport that
 * directory whole (the #1774 fix, `include-hidden-files: true`), so this is
 * additive: it catches the archive_file locations that fix doesn't, without
 * duplicating what it already does.
 *
 * No dependencies, runs on bare node -- same reasoning as
 * check-destructive-plan.mjs: this fires in the Plan job, which sets up
 * Terraform and AWS and nothing else.
 *
 * Usage: node collect-plan-build-artifacts.mjs <plan.json> <repo-root>
 *   Run from the Terraform working directory (e.g.
 *   infra/environments/dev) -- same assumption every other `run:` step in
 *   that job already makes via `defaults.run.working-directory`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { extractArchiveFileOutputPaths } from './plan-build-artifacts.mjs'

function main() {
  const [planPath, repoRoot] = process.argv.slice(2)
  if (!planPath || !repoRoot) {
    console.error('Usage: collect-plan-build-artifacts.mjs <plan.json> <repo-root>')
    process.exit(2)
  }
  if (!existsSync(planPath)) {
    // Fail closed, same posture as check-destructive-plan.mjs: a missing
    // plan means this cannot see what the apply job will need, which is not
    // the same as there being nothing to transport.
    console.error(`::error::Plan file ${planPath} not found.`)
    process.exit(2)
  }

  let plan
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'))
  } catch (err) {
    console.error(`::error::Could not parse ${planPath}: ${err.message}`)
    process.exit(2)
  }

  const workDir = process.cwd()
  const absRepoRoot = resolve(repoRoot)
  const excludedPrefix = resolve(workDir, '.build') + '/'

  const seen = new Set()
  for (const outputPath of extractArchiveFileOutputPaths(plan)) {
    const abs = resolve(workDir, outputPath)

    if ((abs + '/').startsWith(excludedPrefix) || abs === excludedPrefix.slice(0, -1)) {
      // Already carried whole by the tfbuild-<env> .build/ upload.
      continue
    }

    const rel = relative(absRepoRoot, abs)
    if (rel.startsWith('..') || rel === '') {
      // Outside the checkout entirely. Shouldn't happen for a real
      // archive_file inside this repo's module tree, and there is nothing
      // safe to restore it to relative to $GITHUB_WORKSPACE on the apply
      // runner, so warn and skip rather than fail the plan over it.
      console.error(
        `::warning::archive_file output_path resolves outside the repo checkout, skipping: ${outputPath}`,
      )
      continue
    }
    if (!existsSync(abs)) {
      // Resolved by the plan but nothing written -- an apply-deferred data
      // source (see plan-build-artifacts.mjs). Nothing to transport.
      continue
    }
    seen.add(rel)
  }

  for (const rel of [...seen].sort()) {
    console.log(rel)
  }
}

main()
