/**
 * CI guard (ADR-0006 versioning discipline): fail a pull request that changes
 * any template-owned path without bumping `core.version`. Run from CI via
 * `pnpm --filter @biffo/cli check:core-bump`; the base branch comes from
 * `GITHUB_BASE_REF` (or the first CLI arg).
 *
 * Ownership is resolved by the same `isTemplateOwned` logic core upgrade uses,
 * so the guard and the sync agree on what "template-owned" means.
 */
import { execa } from 'execa'
import { readCoreManifest } from '../lib/core-manifest.js'
import { checkCoreVersionBump } from '../lib/core-version-guard.js'
import { CORE_VERSION_FILE } from '../lib/core-version.js'

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

  const manifest = readCoreManifest(root)
  const coreVersionChanged = changedFiles.includes(CORE_VERSION_FILE)
  const { bumpRequired, templateOwnedChanges } = checkCoreVersionBump(
    changedFiles,
    coreVersionChanged,
    manifest,
  )

  if (bumpRequired) {
    console.error(
      `\n✗ core.version bump required.\n\n` +
        `  This PR changes ${templateOwnedChanges.length} template-owned path(s) but does not ` +
        `bump ${CORE_VERSION_FILE}:\n` +
        templateOwnedChanges.map((p) => `    - ${p}`).join('\n') +
        `\n\n  Template-owned changes must move the core version so instances can detect them ` +
        `and \`biffo core upgrade\` has a base to merge from (ADR-0006).\n` +
        `  Bump ${CORE_VERSION_FILE} (patch for fixes, minor for features) in this PR.\n`,
    )
    process.exit(1)
  }

  console.log('✓ core.version guard: OK')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
