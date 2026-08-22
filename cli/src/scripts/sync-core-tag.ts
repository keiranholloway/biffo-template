/**
 * Release the template: derive the next core version and tag HEAD with it.
 *
 * Run from `.github/workflows/core-tag.yml` on every push to `dev`:
 *
 *     pnpm --filter @biffo/cli sync:core-tag -- --push
 *
 * The version is **derived, never read** (#423): it is the highest existing
 * `core-v*` tag, bumped by the conventional type of the commit being released
 * (see `../lib/release-version.ts`). No file in the tree names the version, so
 * nothing can name one that is already taken, and nothing has to be hand-edited
 * in lockstep with the change it describes.
 *
 * That derivation is what retired most of this script. When the version came
 * from a committed `core.version` file, the file could name a version that had
 * already been tagged and published — so this script also had to detect a tag
 * whose template tree had drifted from HEAD, refuse to move it (npm versions
 * are immutable; the tag cannot take the published artifact with it, #342), and
 * re-audit every historical tag to catch the same fault arriving by another
 * route. A derived version cannot repeat, so all of that is unreachable and has
 * been deleted along with the file.
 *
 * What survives is one ancestry check. `git tag` is not covered by branch
 * protection, so a tag can still be created or moved by hand onto a commit that
 * is not in dev's history — and the highest tag is now the base every later
 * version is derived from.
 *
 * Without `--push` it reports what it would do, changing nothing — how the
 * tests drive it.
 *
 * Instance-safe: an instance (detected by `biffo.core.json`, the same marker
 * the Release Guards job uses) exits immediately. `core-v*` is the template's
 * tag namespace, never an instance's.
 */
import { existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from '../lib/exec.js'
import { readCoreManifest } from '../lib/core-manifest.js'
import { coreVersionTag, releasePathspecs } from '../lib/core-tags.js'
import { INSTANCE_CORE_FILE, latestCoreVersionFromTags } from '../lib/core-version.js'
import { decideRelease } from '../lib/release-version.js'

interface Git {
  (args: string[]): Promise<string>
  ok(args: string[]): Promise<boolean>
}

function gitIn(cwd: string): Git {
  const run = async (args: string[]): Promise<string> =>
    (await execa('git', args, { cwd })).stdout.trim()
  const git = run as Git
  git.ok = async (args: string[]) =>
    (await execa('git', args, { cwd, reject: false })).exitCode === 0
  return git
}

function notice(kind: 'notice' | 'warning' | 'error', message: string): void {
  console.log(`::${kind}::${message}`)
}

function summary(markdown: string): void {
  const path = process.env['GITHUB_STEP_SUMMARY']
  if (path) appendFileSync(path, `${markdown}\n`)
}

function output(key: string, value: string): void {
  const path = process.env['GITHUB_OUTPUT']
  if (path) appendFileSync(path, `${key}=${value}\n`)
}

async function main(): Promise<void> {
  const push = process.argv.includes('--push')
  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()
  const git = gitIn(root)

  if (existsSync(join(root, INSTANCE_CORE_FILE))) {
    console.log(
      `✓ core tag sync: skipped — ${INSTANCE_CORE_FILE} present, so this is an instance, not the template. ` +
        `core-v* is the template's tag namespace.`,
    )
    return
  }

  const manifest = readCoreManifest(root)
  const pathspecs = releasePathspecs(manifest)
  const head = await git(['rev-parse', 'HEAD'])
  const subject = await git(['log', '-1', '--format=%s', head])

  const latestVersion = latestCoreVersionFromTags(root)
  const latestTag = latestVersion ? coreVersionTag(latestVersion) : null
  const latestCommit = latestTag ? await git(['rev-list', '-n', '1', latestTag]) : null

  // The one hand-editing fault derivation cannot rule out. Tags are unprotected,
  // so the highest one may sit outside dev's history — via a tag pushed by hand
  // or a force-push to dev. Deriving from it would mint a successor to a tree
  // that dev never carried.
  if (
    latestCommit !== null &&
    !(await git.ok(['merge-base', '--is-ancestor', latestCommit, head]))
  ) {
    notice(
      'error',
      `${latestTag} points at ${latestCommit.slice(0, 8)}, which is not an ancestor of HEAD ` +
        `(${head.slice(0, 8)}). The highest core-v* tag is the base every later version is derived ` +
        `from, so it has to be in dev's history. Either a tag was created or moved by hand, or dev ` +
        `was force-pushed. Resolve deliberately: establish what npm actually shipped as ${latestVersion} ` +
        `(\`npm view @biffo/cli@${latestVersion} gitHead\`), then repoint or delete ${latestTag} knowing ` +
        `what it costs. Nothing is lost meanwhile — the work at HEAD is simply unreleased.`,
    )
    summary(
      `### ❌ \`${latestTag}\` is not in \`dev\`'s history\n\n` +
        `It points at \`${latestCommit.slice(0, 8)}\`; HEAD is \`${head.slice(0, 8)}\`. The highest ` +
        `\`core-v*\` tag is the base the next version is derived from, so releases are blocked until ` +
        `it is back in \`dev\`'s history.\n\n` +
        `Tags are not covered by branch protection, so this is reachable by a hand-pushed tag or a ` +
        `force-push to \`dev\`. Check \`npm view @biffo/cli@${latestVersion} gitHead\` before moving ` +
        `anything — an npm version is immutable and cannot follow its tag (#342).\n`,
    )
    process.exit(1)
  }

  const templateTreeChanged =
    latestCommit === null ||
    !(await git.ok(['diff', '--quiet', latestCommit, head, '--', ...pathspecs]))

  const decision = decideRelease({
    latestVersion,
    latestTagIsHead: latestCommit === head,
    templateTreeChanged,
    subject,
  })

  switch (decision.kind) {
    case 'already-released':
      console.log(
        `✓ HEAD (${head.slice(0, 8)}) is already ${coreVersionTag(decision.version)} — nothing to do.`,
      )
      return

    case 'nothing-to-release':
      console.log(
        `✓ No template-owned change since ${latestTag} (${latestCommit?.slice(0, 8)}) — nothing to ` +
          `release. This commit touches only user-owned paths, so there is nothing for an instance ` +
          `to upgrade to.`,
      )
      return

    case 'release': {
      const tag = coreVersionTag(decision.version)
      const from = latestVersion ? `${latestVersion} → ` : 'first release, '
      if (!push) {
        console.log(
          `[dry run] would create ${tag} at ${head.slice(0, 8)} (${from}${decision.version}).`,
        )
        return
      }
      await git(['config', 'user.name', 'github-actions[bot]'])
      await git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
      await git(['tag', '-a', tag, '-m', `Biffo core ${decision.version}`, head])
      await git(['push', 'origin', `refs/tags/${tag}`])
      console.log(`Created and pushed ${tag} at ${head.slice(0, 8)}.`)
      output('tag', tag)
      output('version', decision.version)
      output('action', 'create')
      summary(
        `### 🏷️ Released \`${decision.version}\`\n\n` +
          `\`${tag}\` → \`${head.slice(0, 8)}\` (${from}\`${decision.version}\`), derived from the ` +
          `commit subject:\n\n> ${subject}\n\n` +
          `\`publish-cli.yml\` picks the tag up and publishes \`@biffo/cli@${decision.version}\`.\n`,
      )
      return
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
