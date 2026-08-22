/**
 * CI entrypoint for the skeleton-drift guard: fail when a fix this repo made
 * for itself never reached the scaffolding trees it hands out — a runner
 * pinned to `ubuntu-latest`, the paid/broken `gitleaks-action`, an
 * unhardened dependency audit, or a hard-coded app title. Each rule in
 * `SKELETON_RULES` names the issue where a generated repo actually shipped
 * broken because of exactly this drift; see `skeleton-drift-guard.ts`'s
 * module doc comment for the fuller argument.
 *
 * Skeletons are discovered, not enumerated — a directory under `_skeletons/`
 * that ships `.github/workflows/ci.yml`, the same discriminator
 * `skeleton-governance-workflows.test.ts` uses to tell a real repo skeleton
 * from `_skeletons/registry/` (plugin-registry content, never scaffolded
 * into a repo). A hardcoded name list would need a human to remember to add
 * a new skeleton to it — the exact failure shape #1271 already found once.
 *
 * Shipped as a guard with its own `.test.ts` (which asserts both real
 * skeletons hold every rule) but had zero callers as a CI *guard* until this
 * guard-wiring pass (biffo-template#1363) — nothing ran it from
 * `cli/src/commands/` or a named workflow step until now.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from '../lib/exec.js'
import {
  auditSkeleton,
  formatViolations,
  type SkeletonViolation,
} from '../lib/skeleton-drift-guard.js'
import { findWorkflowFiles } from '../lib/terraform-input-guard.js'

/** A directory under `_skeletons/` counts as a real repo skeleton only if it
 * ships a CI workflow — the same test `skeleton-governance-workflows.test.ts`
 * uses to exclude `_skeletons/registry/`. */
function discoverSkeletons(root: string): string[] {
  const skeletonsDir = join(root, '_skeletons')
  let entries: string[]
  try {
    entries = readdirSync(skeletonsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
  return entries
    .filter((name) => existsSync(join(skeletonsDir, name, '.github', 'workflows', 'ci.yml')))
    .sort()
}

export async function runSkeletonDriftCheck(): Promise<void> {
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  const skeletons = discoverSkeletons(root)

  // Rough count of files each rule can actually apply to, per skeleton:
  // workflow files (the runner-label / gitleaks / dependency-audit rules) plus
  // the root layout the derived-app-title rule targets, if present. This is
  // what auditSkeleton actually reads, not a whole-tree file count that would
  // overstate what the rules can see.
  let filesConsidered = 0
  for (const name of skeletons) {
    const skeletonRoot = join(root, '_skeletons', name)
    filesConsidered += findWorkflowFiles(skeletonRoot).length
    if (existsSync(join(skeletonRoot, 'apps', 'frontend', 'src', 'app', 'layout.tsx'))) {
      filesConsidered += 1
    }
  }

  console.log(
    `audited ${skeletons.length} skeleton(s) (${skeletons.join(', ') || 'none'}), ` +
      `${filesConsidered} file(s) considered, under ${root}/_skeletons`,
  )

  if (skeletons.length === 0) {
    // This repo always ships _skeletons/plugin-template and
    // _skeletons/sibling-template. Zero here means discovery broke.
    console.error(
      '✗ Skeleton-drift guard: found 0 repo skeletons under _skeletons/ — this looks like a ' +
        'broken scan, not a repo with no scaffolding. Refusing to report success over zero input.',
    )
    process.exit(1)
  }

  const violations: SkeletonViolation[] = skeletons.flatMap((name) =>
    auditSkeleton(join(root, '_skeletons', name), name),
  )

  if (violations.length > 0) {
    console.error('✗ Skeleton-drift guard: drift found between this repo and its scaffolding\n')
    console.error(formatViolations(violations))
    console.error('\nSee skeleton-drift-guard.ts for why each rule exists.')
    process.exit(1)
  }

  console.log(`✓ Skeleton-drift guard: every skeleton holds every rule`)
}
