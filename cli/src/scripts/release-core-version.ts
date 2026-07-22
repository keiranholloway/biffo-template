/**
 * Derive and commit the next `core.version` after a merge to the default branch
 * (issue #423).
 *
 * Runs before the tag step in `core-tag.yml`, so the tag it creates points at a
 * commit whose `core.version` is already correct.
 *
 * Nothing bumps the version by hand any more. A single global counter that every
 * template-owned PR had to edit made a conflict between concurrent PRs certain —
 * and the guard that enforced it never checked the number was going *up*, so a
 * revert could restore an already-published version (#422). Deriving it removes
 * both.
 *
 * Without `--push` it reports what it would do and writes nothing, which is how
 * the tests drive it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { CORE_VERSION_FILE, isInstanceRepo } from '../lib/core-version.js'
import { readCoreManifest } from '../lib/core-manifest.js'
import { isTemplateOwned } from '../lib/core-manifest.js'
import { isReleaseCommit, nextCoreVersion, releaseCommitSubject } from '../lib/release-version.js'

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa('git', args, { cwd, reject: false })
  return stdout.trim()
}

async function main(): Promise<void> {
  const push = process.argv.includes('--push')
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  // Template only. This script ships to instances in the template-owned cli/,
  // and an instance's version is `biffo.core.json`, written by core upgrade.
  if (isInstanceRepo(root)) {
    console.log('✓ release version: skipped — this is an instance, not the template.')
    return
  }

  const subject = await git(['log', '-1', '--format=%s'], root)

  // Our own push. Without this the job would bump for ever: each release commit
  // is itself a commit on the default branch. `[skip ci]` should already have
  // stopped the re-trigger; this is the belt to that pair of braces, because a
  // loop here mints versions and tags until someone notices.
  if (isReleaseCommit(subject)) {
    console.log(`✓ release version: skipped — ${subject} is this job's own commit.`)
    return
  }

  const versionPath = join(root, CORE_VERSION_FILE)
  if (!existsSync(versionPath)) {
    console.error(`::error::${CORE_VERSION_FILE} not found at the repo root.`)
    process.exit(2)
  }
  const current = readFileSync(versionPath, 'utf8').trim()

  // Only release when something an instance can receive actually changed.
  // A docs-only or infra-only merge moves nothing for any instance, and
  // minting a version for it would produce a tag whose tree is identical to
  // the last one.
  const changed = (await git(['diff', '--name-only', 'HEAD~1..HEAD'], root))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const manifest = readCoreManifest(root)
  const templateOwned = changed.filter(
    (f) => f !== CORE_VERSION_FILE && isTemplateOwned(f, manifest),
  )
  if (templateOwned.length === 0) {
    console.log(
      `✓ release version: no template-owned change in this merge — staying at ${current}.`,
    )
    return
  }

  const next = nextCoreVersion(current, [subject])
  console.log(`Deriving ${current} -> ${next} from ${JSON.stringify(subject)}`)
  console.log(`  ${templateOwned.length} template-owned path(s) changed.`)

  if (!push) {
    console.log(`[dry run] would write ${CORE_VERSION_FILE} and commit (no --push).`)
    return
  }

  writeFileSync(versionPath, `${next}\n`)
  await execa('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: root })
  await execa(
    'git',
    ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'],
    { cwd: root },
  )
  await execa('git', ['add', CORE_VERSION_FILE], { cwd: root })
  await execa('git', ['commit', '-m', releaseCommitSubject(next)], { cwd: root })
  await execa('git', ['push', 'origin', 'HEAD'], { cwd: root })
  console.log(`Committed and pushed ${CORE_VERSION_FILE} = ${next}.`)

  const summaryPath = process.env['GITHUB_STEP_SUMMARY']
  if (summaryPath) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(
      summaryPath,
      `### Core version ${next}\n\nDerived from \`${subject}\` (was ${current}).\n`,
    )
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
