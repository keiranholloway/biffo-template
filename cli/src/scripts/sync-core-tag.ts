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
 *   1. **Tag.** Create `core-v<version>` at HEAD when no such tag exists. A tag
 *      that already stands for this tree is left alone, so it does not chase
 *      user-owned commits. Anything else — a tag whose template tree has moved
 *      underneath it, or one pointing off-branch — is a hard failure. This
 *      script never repoints an existing tag: it is a published release, and
 *      the npm artifact behind it cannot move with it (#342). See the reasoning
 *      in `../lib/core-tags.ts`.
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
 * Step output, so the workflow can act on what happened here.
 *
 * Specifically: whether a tag was actually created. A release must only be
 * dispatched when there is a new tag to release — not on every push to the
 * default branch, and not when the tag already stood for this tree.
 */
function output(key: string, value: string): void {
  const path = process.env['GITHUB_OUTPUT']
  if (path) appendFileSync(path, `${key}=${value}\n`)
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
    case 'drifted': {
      const changed = await git(['diff', '--name-only', taggedCommit!, head, '--', ...pathspecs])
      // The #294 collision, reached again. #294 moved the tag here; #342 is why
      // that is now a refusal — the tag is a released version whose npm
      // artifact cannot move with it, so repointing it only makes the two
      // disagree. Never silent, and never automatic: this needs a person
      // holding the answer to "what is actually inside @biffo/cli@<version>?".
      notice(
        'error',
        `Refusing to move ${tag}. It points at ${taggedCommit!.slice(0, 8)}, whose template-owned tree ` +
          `differs from HEAD (${head.slice(0, 8)}) while core.version has stayed at ${version} — two commits ` +
          `on main are shipping one released version. ${tag} was already pushed and publish-cli.yml was ` +
          `already dispatched against it, so npm may hold ${version} built from the other tree; moving the ` +
          `tag cannot move the published package with it (#342).`,
      )
      notice(
        'error',
        `Fix forward: land a core.version bump on main. The tree at HEAD then gets a version, a tag and a ` +
          `release of its own, and no published artifact is contradicted.`,
      )
      // Say this here rather than let someone discover it: bumping releases the
      // new tree but does NOT clear the audit, because the tree at this version
      // on main is still not the tree the tag names. That question has no
      // mechanical answer — it depends on what npm actually shipped — so main
      // stays red until a person answers it. Which is the point.
      notice(
        'error',
        `Bumping does not on its own clear this: the audit below independently re-derives the same fact, so ` +
          `main stays red until ${tag} and the tree at ${version} agree. Settle that deliberately — repoint or ` +
          `delete ${tag} once you know what npm shipped as ${version}, or raise AUDIT_BASELINE_VERSION past it ` +
          `and record why (as 0.3.14 and 0.23.6 already are).`,
      )
      console.log(`Template-owned paths that differ between ${tag} and HEAD:\n${changed}`)
      summary(
        `### ❌ Refused to move \`${tag}\`\n\n` +
          `\`${taggedCommit!.slice(0, 8)}\` (tagged) vs \`${head.slice(0, 8)}\` (HEAD) — the template-owned ` +
          `tree changed while \`core.version\` stayed at \`${version}\`, so two commits on \`main\` ship one ` +
          `released version.\n\n` +
          `A \`core-v*\` tag is a release: it was pushed and \`publish-cli.yml\` was dispatched against it. ` +
          `npm versions are immutable, so moving the tag would leave \`core-v${version}\` and ` +
          `\`@biffo/cli@${version}\` describing different trees — the failure recorded in #342. #294's ` +
          `original answer (move the tag forward) is superseded.\n\n` +
          `**Template-owned paths that differ**\n\n` +
          '```\n' +
          changed +
          '\n```\n\n' +
          `**How to resolve**\n\n` +
          `1. Establish what was actually released: \`npm view @biffo/cli@${version} gitHead dist.tarball\`.\n` +
          `2. Fix forward — land a \`core.version\` bump on \`main\`, so the tree at HEAD gets its own ` +
          `version, tag and release. Nothing is lost while this is unresolved; it is simply unreleased.\n` +
          `3. Then settle \`${version}\` itself. The bump does **not** clear this on its own — the audit ` +
          `below re-derives the same fact independently, so \`main\` stays red until \`${tag}\` and the tree ` +
          `at \`${version}\` agree. There is no mechanical answer (it depends on what npm shipped), which is ` +
          `why a person has to give one: repoint or delete \`${tag}\` knowing what it costs, or raise ` +
          `\`AUDIT_BASELINE_VERSION\` past \`${version}\` and record why — as 0.3.14 and 0.23.6 already are.\n\n` +
          `**How you might have got here** (branch protection is meant to prevent it): \`core.version\` ` +
          `moved backwards onto an already-released number — the Core Version Guard checks only that it ` +
          `*changed*, not that it increased; a \`core-v*\` tag was deleted or created by hand, as tags are ` +
          `unprotected; or "require branches to be up to date before merging" was turned off on \`main\`.\n`,
      )
      process.exit(1)
      break
    }
    case 'keep':
      console.log(
        `✓ ${tag} already stands for this template tree (${taggedCommit?.slice(0, 8)}) — nothing to do.`,
      )
      break
    case 'create': {
      await git(['config', 'user.name', 'github-actions[bot]'])
      await git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
      // No -f: `create` means the tag does not exist, and every path that would
      // overwrite one has already refused above. A plain `git tag` fails rather
      // than clobbering if that ever stops being true.
      await git(['tag', '-a', tag, '-m', `Biffo core ${version}`, head])
      if (push) {
        // No --force either: this ref is new, and a push that would need force
        // is a push this script has already decided must not happen.
        await git(['push', 'origin', `refs/tags/${tag}`])
        console.log(`Created and pushed ${tag} at ${head.slice(0, 8)}.`)
        // Consumed by core-tag.yml to dispatch the release. Only set when a tag
        // was really pushed, so `keep` and dry runs release nothing.
        output('tag', tag)
        output('action', action)
      } else {
        console.log(`[dry run] would ${action} ${tag} at ${head.slice(0, 8)} (no --push).`)
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
