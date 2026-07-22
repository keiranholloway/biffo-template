/**
 * CI guard (ADR-0006 versioning discipline). `core.version` is no longer bumped
 * by hand — the release job derives it after merge (#423) — so this checks the
 * two things a PR CAN now get wrong:
 *
 *   1. it edits `core.version` itself, which belongs to the release job and is
 *      the only way to move the version backwards onto a published one (#422);
 *   2. it changes template-owned paths under a subject the derivation cannot
 *      read, which under squash-merge decides the released version by accident.
 *
 * Run from CI via `pnpm --filter @biffo/cli check:core-bump`; the base branch
 * comes from `GITHUB_BASE_REF` (or the first CLI arg).
 *
 * Ownership is resolved by the same `isTemplateOwned` logic core upgrade uses,
 * so the guard and the sync agree on what "template-owned" means.
 *
 * The check is template-only: an instance (detected by `biffo.core.json` at its
 * root) skips it, because a core upgrade PR there necessarily rewrites
 * template-owned paths and bumps `biffo.core.json` rather than `core.version`.
 */
import { execa } from 'execa'
import { readCoreManifest } from '../lib/core-manifest.js'
import { checkCoreVersionBump } from '../lib/core-version-guard.js'
import { CORE_VERSION_FILE, INSTANCE_CORE_FILE, isInstanceRepo } from '../lib/core-version.js'

async function main(): Promise<void> {
  const base = process.env['GITHUB_BASE_REF'] ?? process.argv[2]
  if (!base) {
    console.error('No base ref: set GITHUB_BASE_REF or pass a base branch as the first argument.')
    process.exit(2)
  }

  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  await execa('git', ['fetch', '--quiet', 'origin', base], { cwd: root, reject: false })

  const { stdout } = await execa('git', ['diff', '--name-only', `origin/${base}...HEAD`], {
    cwd: root,
  })
  const changedFiles = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  // Under squash-merge the PR TITLE becomes the commit subject on main, and
  // that subject decides the released version. GITHUB_PR_TITLE carries it when
  // CI knows it; the branch's own subjects are the fallback for a local run.
  const prTitle = process.env['GITHUB_PR_TITLE']
  let subjects: string[]
  if (prTitle) {
    subjects = [prTitle]
  } else {
    const { stdout: log } = await execa('git', ['log', '--format=%s', `origin/${base}..HEAD`], {
      cwd: root,
      reject: false,
    })
    subjects = log
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  const manifest = readCoreManifest(root)
  const isInstance = isInstanceRepo(root)
  const { handEdited, unclassifiableSubjects, templateOwnedChanges, skippedAsInstance } =
    checkCoreVersionBump({ changedFiles, manifest, subjects, isInstance })

  if (skippedAsInstance) {
    console.log(
      `✓ core.version guard: skipped — this is an instance (${INSTANCE_CORE_FILE} present), ` +
        `not the template. Instances track core via ${INSTANCE_CORE_FILE}.`,
    )
    return
  }

  if (handEdited) {
    console.error(
      `\n✗ ${CORE_VERSION_FILE} must not be edited by hand.\n\n` +
        `  The release job derives it from this PR's commit type after merge (#423), so a\n` +
        `  PR that sets it fights the automation — and a hand-edit is the only way to move\n` +
        `  it BACKWARDS onto an already-published version (#422). core-v<version> is\n` +
        `  released to npm, and npm versions are immutable, so two commits carrying one\n` +
        `  version disagree for ever.\n\n` +
        `  Drop ${CORE_VERSION_FILE} from this PR. Nothing else is needed — the version is\n` +
        `  chosen for you.\n`,
    )
    process.exit(1)
  }

  if (unclassifiableSubjects.length > 0) {
    console.error(
      `\n✗ This PR releases a new core version, but its subject cannot be classified.\n\n` +
        unclassifiableSubjects.map((s) => `    ${s}`).join('\n') +
        `\n\n  Squash-merge makes the PR title the commit subject on main, and the release\n` +
        `  job reads that subject to decide the version (feat -> minor, otherwise patch).\n` +
        `  An unreadable title picks the version by accident.\n\n` +
        `  Use a Conventional Commit title, e.g. \`fix(cli): ...\` or \`feat(api): ...\`.\n` +
        `  It changes ${templateOwnedChanges.length} template-owned path(s), which is why this matters.\n`,
    )
    process.exit(1)
  }

  console.log('✓ core.version guard: OK — the release job will set the version.')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
