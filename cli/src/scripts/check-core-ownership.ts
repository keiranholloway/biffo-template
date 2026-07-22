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
 */
import { execa } from 'execa'
import {
  DIVERGENCE_FILE,
  checkCoreOwnership,
  readDivergenceConfig,
} from '../lib/core-ownership-guard.js'
import { readCoreManifest } from '../lib/core-manifest.js'
import { isInstanceRepo } from '../lib/core-version.js'

const BOLD = '[1m'
const DIM = '[2m'
const RED = '[31m'
const YELLOW = '[33m'
const OFF = '[0m'

async function main(): Promise<void> {
  // `pnpm run <script> -- --staged x` forwards the `--` itself as an argument,
  // so drop it rather than letting it be read as a base ref.
  const args = process.argv.slice(2).filter((a) => a !== '--')
  const stagedFlag = args.indexOf('--staged')
  const staged = stagedFlag !== -1
  const messageFile = staged ? args[stagedFlag + 1] : undefined

  const root = (await execa('git', ['rev-parse', '--show-toplevel'])).stdout.trim()

  if (!isInstanceRepo(root)) {
    console.log('✓ core ownership guard: skipped — this is the template, which owns these paths.')
    return
  }

  let changedFiles: string[]
  let commitMessage = ''

  if (staged) {
    // ACMR: a path the commit deletes is not drift the template can carry back.
    const { stdout } = await execa(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
      { cwd: root },
    )
    changedFiles = splitLines(stdout)
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
    const { stdout } = await execa('git', ['diff', '--name-only', `origin/${base}...HEAD`], {
      cwd: root,
    })
    changedFiles = splitLines(stdout)
    // On a PR the trailer lives in the commits, not in a message file.
    const { stdout: log } = await execa('git', ['log', '--format=%B', `origin/${base}..HEAD`], {
      cwd: root,
      reject: false,
    })
    commitMessage = log
  }

  // A detached HEAD or a fresh repo has no branch name; fall through to the
  // file check rather than guessing an exemption.
  const { stdout: branch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root,
    reject: false,
  })

  const result = checkCoreOwnership({
    changedFiles,
    manifest: readCoreManifest(root),
    isInstance: true,
    branch: branch.trim(),
    commitMessage,
    warnOnly: readDivergenceConfig(root).warnOnly,
  })

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

${BOLD}If the divergence is deliberate${OFF}
  Record it in the commit message and it is allowed:

    ${DIM}Core-Divergence: <why this instance must differ from the template>${OFF}

  Raise an upstream issue too, so it does not stay divergent by accident. For a
  boundary you knowingly sit astride, add a warn-only prefix to ${DIVERGENCE_FILE}.
`)
  process.exit(1)
}

function splitLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
