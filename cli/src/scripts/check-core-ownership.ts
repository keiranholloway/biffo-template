/**
 * Runner for the template-ownership guard (issue #370). Two modes, one rule:
 *
 *   - `--staged <commit-msg-file>` — the `.husky/commit-msg` hook. Reads staged
 *     paths and the message being written, so the guard fires before the commit
 *     exists rather than after it is pushed.
 *   - default — CI. Diffs the PR against its base. A hook is bypassable with
 *     `--no-verify`; this is not, which is why both exist.
 *
 * The decision itself lives in lib/core-ownership-guard.ts. This file only
 * gathers git state and renders the result.
 *
 * Inert in the template, where editing template-owned paths is the entire job —
 * see the direction-of-check note in the lib module.
 *
 * Inert for the same reason in a satellite (sibling app, plugin repo, package,
 * runner fleet, the design repo) — but for a different reason, and the two must
 * not share a message (#1328). `classifyRepoOwnership` tells them apart: a
 * satellite is also not an instance, but unlike the template it holds no
 * `core-manifest.json` and no template-owned paths to guard at all.
 */
import { execa } from '../lib/exec.js'
import {
  DIVERGENCE_FILE,
  checkCoreOwnership,
  classifyRepoOwnership,
  parseNameStatus,
  readDivergenceConfig,
  resolveBranch,
} from '../lib/core-ownership-guard.js'
import { UPGRADE_BRANCH_PREFIX } from '../lib/core-upgrade.js'
import { readCoreManifest } from '../lib/core-manifest.js'
import { fetchTemplateShippedPaths } from '../lib/template-shipped-paths.js'
import { resolveUpgradeCommitFiles } from '../lib/upgrade-commit-files.js'

/**
 * The integration branch is `dev` in every Biffo repo (AGENTS.md §2), and an
 * upgrade branch is always cut from it (`git switch -c <upgrade-branch>` off
 * a caller checkout that is on `dev`) -- so it is the correct, offline-safe
 * base for the local commit-msg hook to compare against when scoping the
 * upgrade-branch exemption to the mechanical commit alone (#1993). This reads
 * whatever `origin/dev` already resolves to locally; it never fetches, which
 * is why the hook stays fast and safe to run disconnected.
 */
const LOCAL_UPGRADE_BASE = 'origin/dev'

const BOLD = '[1m'
const DIM = '[2m'
const RED = '[31m'
const YELLOW = '[33m'
const OFF = '[0m'

export async function runOwnershipCheck(argv: string[]): Promise<void> {
  // `pnpm run <script> -- --staged x` forwards the `--` itself as an argument,
  // so drop it rather than letting it be read as a base ref.
  const args = argv.filter((a) => a !== '--')
  const stagedFlag = args.indexOf('--staged')
  const staged = stagedFlag !== -1
  const messageFile = staged ? args[stagedFlag + 1] : undefined

  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  const ownership = classifyRepoOwnership(root)
  if (ownership === 'template') {
    console.log('✓ core ownership guard: skipped — this is the template, which owns these paths.')
    return
  }
  if (ownership === 'satellite') {
    console.log(
      '✓ core ownership guard: skipped — this repo is not an instance, so it holds no template-owned paths.',
    )
    return
  }

  let changedFiles: string[]
  let deletedFiles: string[] = []
  let commitMessage = ''
  // CI-mode base ref, as `origin/<base>` -- kept in outer scope because it is
  // also the base the upgrade-commit-file resolver below diffs against, once
  // the branch is known to be an upgrade branch.
  let ciBase: string | null = null

  if (staged) {
    // --name-status, unfiltered, exactly as the CI branch below. Deletions are
    // INCLUDED: deleting a template-owned file is drift, and a silent kind —
    // an upgrade will not restore it (#395), so the instance simply loses a
    // core file for ever. The two modes previously disagreed here (#411).
    const { stdout } = await execa('git', ['diff', '--cached', '--name-status'], { cwd: root })
    ;({ changed: changedFiles, deleted: deletedFiles } = parseNameStatus(stdout))
    if (messageFile) {
      const { readFileSync, existsSync } = await import('node:fs')
      if (existsSync(messageFile)) commitMessage = readFileSync(messageFile, 'utf8')
    }
  } else {
    const base = process.env['GITHUB_BASE_REF'] ?? args[0]
    if (!base) {
      console.error('No base ref: set GITHUB_BASE_REF or pass a base branch as the first argument.')
      process.exit(2)
    }
    await execa('git', ['fetch', '--quiet', 'origin', base], { cwd: root, reject: false })
    ciBase = `origin/${base}`
    const { stdout } = await execa('git', ['diff', '--name-status', `${ciBase}...HEAD`], {
      cwd: root,
    })
    ;({ changed: changedFiles, deleted: deletedFiles } = parseNameStatus(stdout))
    // On a PR the trailer lives in the commits, not in a message file.
    const { stdout: log } = await execa('git', ['log', '--format=%B', `${ciBase}..HEAD`], {
      cwd: root,
      reject: false,
    })
    commitMessage = log
  }

  const { stdout: gitBranch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root,
    reject: false,
  })
  const branch = resolveBranch(process.env, gitBranch)

  // Scope the upgrade-branch exemption to the CLI's own mechanical commit,
  // not the whole branch (#1993) -- reproduced live on tabsii-platform#1420,
  // where a second, human/agent commit on an upgrade branch edited a
  // user-owned path and the whole-branch skip let it through unchecked.
  // `resolveUpgradeCommitFiles` returns `null` ("could not tell") on any
  // failure, which `checkCoreOwnership` treats as "exempt nothing" -- never
  // the old fail-open "exempt everything" this replaces.
  const upgradeCommitFiles = branch.startsWith(UPGRADE_BRANCH_PREFIX)
    ? await resolveUpgradeCommitFiles(
        root,
        ciBase ?? LOCAL_UPGRADE_BASE,
        staged ? { stagedFallbackFiles: changedFiles } : {},
      )
    : null

  // Only in CI/PR-diff mode: this is the check this file's own docstring says
  // cannot be bypassed with `--no-verify`, and GitHub Actions runners always
  // have network egress. The local commit-msg hook stays fast and offline-safe
  // — a per-commit network fetch there would slow every developer commit and
  // break disconnected work, so it keeps the manifest-prefix-only behaviour
  // this guard has always had (see `fetchTemplateShippedPaths`'s doc on why
  // `null` — "could not tell" — is always the safe fallback, never treated as
  // "the template ships nothing").
  const templateShippedPaths = staged ? null : await fetchTemplateShippedPaths(root)
  if (!staged && templateShippedPaths === null) {
    console.error(
      `${YELLOW}⚠ core ownership guard: could not fetch biffo-template's dev tree (offline, ` +
        `network failure, or timeout) — falling back to the manifest prefix list alone, which ` +
        `cannot tell an instance-only file from a real template file under the same prefix ` +
        `(#1912).${OFF}`,
    )
  }

  const result = checkCoreOwnership({
    changedFiles,
    manifest: readCoreManifest(root),
    isInstance: true,
    branch,
    commitMessage,
    warnOnly: readDivergenceConfig(root).warnOnly,
    upgradeCommitFiles,
    templateShippedPaths,
  })

  if (result.knownOrphans.length > 0) {
    console.log(
      `${DIM}ℹ ${result.knownOrphans.length} path(s) matched a template-owned prefix, but ` +
        `biffo-template's dev branch does not ship them — treated as instance-owned, no ` +
        `Core-Divergence trailer needed (#1912):${OFF}`,
    )
    for (const path of result.knownOrphans) {
      console.log(`    ${DIM}${path}${OFF}`)
    }
  }

  for (const { path, entry } of result.warned) {
    console.error(
      `${YELLOW}⚠ ${path}${OFF} ${DIM}— known divergence in ${entry.prefix} (${entry.upstream}); ` +
        `still conflicts at the next core upgrade.${OFF}`,
    )
  }

  if (result.skipped === 'upgrade-branch') {
    console.log('✓ core ownership guard: skipped — this is a core-upgrade branch.')
    return
  }
  if (result.skipped === 'divergence-trailer') {
    console.log(
      `✓ core ownership guard: allowed by Core-Divergence: ${result.divergenceReason ?? ''}`,
    )
    return
  }
  if (result.skipped === 'convergence-trailer') {
    console.log(
      `✓ core ownership guard: allowed by Core-Convergence (reverting toward the template): ` +
        `${result.convergenceReason ?? ''}`,
    )
    return
  }
  if (result.blocked.length === 0) {
    console.log('✓ core ownership guard: no template-owned paths changed.')
    return
  }

  const shown = result.blocked.slice(0, 15)
  const more = result.blocked.length - shown.length
  console.error(`
${RED}${BOLD}✗ This change edits template-owned paths.${OFF}

${shown.map((p) => `    ${RED}${p}${OFF}`).join('\n')}${
    more > 0 ? `\n    ${DIM}…and ${more} more${OFF}` : ''
  }

${BOLD}Why this is blocked${OFF}
  core-manifest.json marks these as owned by biffo-template. Changing them here
  breaks nothing today — it becomes a merge conflict at the next
  \`biffo core upgrade\`, long after the reasoning is gone.

${BOLD}What to do instead${OFF}
  Make the change in biffo-template, release it, and take it here with
  \`biffo core upgrade\`. Instance-specific behaviour belongs in a user-owned
  path — see core-manifest.json for the split.

${
  result.blocked.some((p) => deletedFiles.includes(p))
    ? `${BOLD}Some of these are deletions${OFF}
  Deleting a template-owned file is drift like any other: the next
  \`biffo core upgrade\` will restore it (#395) unless you declare the path an
  intentional divergence. If the file genuinely should not exist, delete it in
  biffo-template so every instance drops it.

`
    : ''
}${BOLD}If this REMOVES divergence (reverting toward the template)${OFF}
  Reverting a template-owned file to the template's own content, or deleting a
  file the template no longer ships, leaves the instance strictly closer to the
  template. Record that it converges — it is allowed, and kept distinct from a
  divergence so it never reads as drift to chase later (#385):

    ${DIM}Core-Convergence: <what this reverts toward the template>${OFF}

${BOLD}If the divergence is deliberate${OFF}
  Record it in the commit message and it is allowed:

    ${DIM}Core-Divergence: <why this instance must differ from the template>${OFF}

  Raise an upstream issue too, so it does not stay divergent by accident. For a
  boundary you knowingly sit astride, add a warn-only prefix to ${DIVERGENCE_FILE}.
`)
  process.exit(1)
}
