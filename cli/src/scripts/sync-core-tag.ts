/**
 * Keep `core-v<version>` standing for the template tree at that version, and
 * assert it across main's history (ADR-0006, issue #294).
 *
 * Run from `.github/workflows/core-tag.yml` on every push to `main`:
 *
 *     pnpm --filter @biffo/cli sync:core-tag -- --push
 *
 * Two phases, in order:
 *
 *   1. **Tag.** Create `core-v<version>` at HEAD, or move it forward when the
 *      template-owned tree has changed underneath an existing tag. A tag that
 *      already stands for this tree is left alone, so it does not chase
 *      user-owned commits. A tag pointing off-branch is a hard failure.
 *   2. **Audit.** Re-derive, for every core version on `main` at or above the
 *      audit baseline, the newest commit carrying it, and assert its tag stands
 *      for that tree. Prevention plus detection: if the tagging path regresses,
 *      main goes red at once instead of the drift being found by hand days
 *      later, which is how #294 was found.
 *
 * Without `--push` it reports what it would do and audits, changing nothing —
 * how the tests drive it.
 *
 * Instance-safe: an instance (detected by `biffo.core.json`, the same marker
 * the Core Version Guard uses) exits immediately. `core-v*` is the template's
 * tag namespace, never an instance's.
 */
import { existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { readCoreManifest } from '../lib/core-manifest.js'
import {
  AUDIT_BASELINE_VERSION,
  auditCoreTags,
  coreVersionTag,
  decideTagAction,
  formatTagViolations,
  templateOwnedPathspecs,
  type CoreTagFact,
} from '../lib/core-tags.js'
import {
  CORE_VERSION_FILE,
  INSTANCE_CORE_FILE,
  compareCoreVersions,
  readCoreVersionFile,
} from '../lib/core-version.js'

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

/** GitHub Actions annotation — surfaces in the run's Annotations panel, not just the log. */
function notice(kind: 'notice' | 'warning' | 'error', message: string): void {
  console.log(`::${kind}::${message}`)
}

function summary(markdown: string): void {
  const path = process.env['GITHUB_STEP_SUMMARY']
  if (path) appendFileSync(path, `${markdown}\n`)
}

/**
 * Every core version on `main` at or above `baseline`, with the newest commit
 * carrying it.
 *
 * Derived from the commits that *changed* `core.version` (cheap: one walk plus
 * a couple of calls each) rather than reading the file at every commit. The
 * newest commit carrying the version introduced at change-commit `c` is the
 * first parent of the next *newer* change commit — or HEAD, for the newest
 * change of all.
 */
async function collectFacts(
  git: Git,
  head: string,
  pathspecs: string[],
  baseline: string,
): Promise<CoreTagFact[]> {
  const changes = (await git(['rev-list', '--first-parent', head, '--', CORE_VERSION_FILE]))
    .split('\n')
    .filter(Boolean)

  const facts: CoreTagFact[] = []
  const seen = new Set<string>()
  for (const [i, commit] of changes.entries()) {
    const version = (await git(['show', `${commit}:${CORE_VERSION_FILE}`])).trim()
    // Versions on main are monotonic, so the first one below the baseline ends
    // the audit window.
    if (compareCoreVersions(version, baseline) < 0) break
    // A version can in principle appear more than once (a revert); the newest
    // occurrence is the one the tag must stand for.
    if (seen.has(version)) continue
    seen.add(version)

    const newer = changes[i - 1]
    const headOfVersion = newer ? await git(['rev-parse', `${newer}^1`]) : head
    const tag = coreVersionTag(version)
    const taggedCommit = (await git.ok(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]))
      ? await git(['rev-list', '-n', '1', tag])
      : null
    const templateTreeMatches =
      taggedCommit !== null &&
      (await git.ok(['diff', '--quiet', taggedCommit, headOfVersion, '--', ...pathspecs]))
    facts.push({ version, headOfVersion, taggedCommit, templateTreeMatches })
  }
  return facts
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
  const pathspecs = templateOwnedPathspecs(manifest)
  const version = readCoreVersionFile(join(root, CORE_VERSION_FILE))
  const tag = coreVersionTag(version)
  const head = await git(['rev-parse', 'HEAD'])

  const tagExists = await git.ok(['rev-parse', '-q', '--verify', `refs/tags/${tag}`])
  const taggedCommit = tagExists ? await git(['rev-list', '-n', '1', tag]) : null
  const taggedCommitIsAncestorOfHead =
    taggedCommit !== null && (await git.ok(['merge-base', '--is-ancestor', taggedCommit, head]))
  const templateTreeDiffers =
    taggedCommit !== null &&
    !(await git.ok(['diff', '--quiet', taggedCommit, head, '--', ...pathspecs]))

  const action = decideTagAction({ tagExists, taggedCommitIsAncestorOfHead, templateTreeDiffers })

  switch (action) {
    case 'conflict':
      notice(
        'error',
        `${tag} points at ${taggedCommit?.slice(0, 8)}, which is not an ancestor of HEAD (${head.slice(0, 8)}). ` +
          `Refusing to move it: that tag is the only record of which tree ${version} meant. Resolve by hand.`,
      )
      process.exit(1)
      break
    case 'keep':
      console.log(
        `✓ ${tag} already stands for this template tree (${taggedCommit?.slice(0, 8)}) — nothing to do.`,
      )
      break
    case 'create':
    case 'move': {
      if (action === 'move') {
        const changed = await git(['diff', '--name-only', taggedCommit!, head, '--', ...pathspecs])
        // Loud on purpose: a moving tag is surprising, and anything that pinned
        // the old SHA sees it shift. This is the #294 collision — two commits
        // shipped the same core.version, and the tag must stand for the later
        // template tree or the later commit reaches no instance, ever.
        notice(
          'warning',
          `Moving ${tag} from ${taggedCommit!.slice(0, 8)} to ${head.slice(0, 8)}: the template-owned tree ` +
            `changed while core.version stayed at ${version} (issue #294). Anything pinned to the old SHA ` +
            `will see this tag move; the old commit itself is untouched and still on main.`,
        )
        console.log(`Template-owned paths that changed under ${tag}:\n${changed}`)
        summary(
          `### ⚠️ Moved \`${tag}\`\n\n\`${taggedCommit!.slice(0, 8)}\` → \`${head.slice(0, 8)}\`\n\n` +
            `The template-owned tree changed while \`core.version\` stayed at \`${version}\` — two ` +
            `commits shipped the same version (#294). The tag now stands for the later tree.\n\n` +
            '```\n' +
            changed +
            '\n```\n',
        )
      }
      await git(['config', 'user.name', 'github-actions[bot]'])
      await git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
      await git(['tag', '-f', '-a', tag, '-m', `Biffo core ${version}`, head])
      if (push) {
        await git(['push', '--force', 'origin', `refs/tags/${tag}`])
        console.log(
          `${action === 'move' ? 'Moved' : 'Created'} and pushed ${tag} at ${head.slice(0, 8)}.`,
        )
      } else {
        console.log(`[dry run] would ${action} ${tag} to ${head.slice(0, 8)} (no --push).`)
      }
      break
    }
  }

  const facts = await collectFacts(git, head, pathspecs, AUDIT_BASELINE_VERSION)
  const violations = auditCoreTags(facts, AUDIT_BASELINE_VERSION)
  if (violations.length > 0) {
    console.error(formatTagViolations(violations))
    notice(
      'error',
      `${violations.length} core-v* tag(s) do not resolve to their version's template tree.`,
    )
    process.exit(1)
  }
  console.log(
    `✓ core tag audit: ${facts.length} version(s) from ${AUDIT_BASELINE_VERSION} up each resolve to the template tree at that version.`,
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
