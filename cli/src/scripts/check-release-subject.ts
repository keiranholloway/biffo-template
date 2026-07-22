/**
 * CI guard (ADR-0006 versioning discipline): on a pull request that changes any
 * template-owned path, fail unless the **pull request title** parses as a
 * Conventional Commits subject.
 *
 * Run from CI via `pnpm --filter @biffo/cli check:release-subject`, with the PR
 * title in `PR_TITLE` and the base branch in `GITHUB_BASE_REF`.
 *
 * This replaced the `core.version` bump guard when #423 made the version
 * derived. The reasoning for the swap — and why the PR title specifically, given
 * squash-merge — is in `../lib/release-subject-guard.ts`.
 *
 * Ownership is resolved by the same `isTemplateOwned` logic core upgrade uses,
 * so the guard and the sync agree on what "template-owned" means.
 */
import { execa } from 'execa'
import { readCoreManifest } from '../lib/core-manifest.js'
import { INSTANCE_CORE_FILE, isInstanceRepo } from '../lib/core-version.js'
import { checkReleaseSubject } from '../lib/release-subject-guard.js'

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

  // The subject the release will actually be derived from. Under squash-merge
  // that is the PR title; falling back to the head commit keeps the script
  // usable locally, where there is no PR.
  const subject =
    process.env['PR_TITLE']?.trim() ||
    (await execa('git', ['log', '-1', '--format=%s'], { cwd: root })).stdout.trim()

  const manifest = readCoreManifest(root)
  const { unparseable, bump, templateOwnedChanges, skippedAsInstance } = checkReleaseSubject(
    changedFiles,
    subject,
    manifest,
    isInstanceRepo(root),
  )

  if (skippedAsInstance) {
    console.log(
      `✓ release subject guard: skipped — this is an instance (${INSTANCE_CORE_FILE} present), ` +
        `not the template. Instances cut no core-v* release, so the title is not a release input.`,
    )
    return
  }

  if (templateOwnedChanges.length === 0) {
    console.log(
      '✓ release subject guard: no template-owned change, so this PR releases nothing and its ' +
        'title is not a release input.',
    )
    return
  }

  if (unparseable) {
    console.error(
      `\n✗ Pull request title is not a Conventional Commits subject.\n\n` +
        `  Title: ${subject}\n\n` +
        `  This PR changes ${templateOwnedChanges.length} template-owned path(s), so merging it ` +
        `cuts a core release:\n` +
        templateOwnedChanges
          .slice(0, 10)
          .map((p) => `    - ${p}`)
          .join('\n') +
        (templateOwnedChanges.length > 10
          ? `\n    … and ${templateOwnedChanges.length - 10} more`
          : '') +
        `\n\n  Squash-merge makes this title the commit subject on \`main\`, and the release job ` +
        `derives the version bump from it (ADR-0006, #423). A title it cannot parse silently ` +
        `becomes a patch — so a feature would ship as one, and instances tracking the minor line ` +
        `would never see it.\n\n` +
        `  Retitle as \`type(scope): summary\` — e.g. \`feat(api): add run history endpoint\`. ` +
        `Use \`feat\` for a feature, \`fix\` for a fix, a trailing \`!\` for a breaking change.\n`,
    )
    process.exit(1)
  }

  console.log(
    `✓ release subject guard: "${subject}" → ${bump ?? 'patch'} release for ` +
      `${templateOwnedChanges.length} template-owned change(s).`,
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
