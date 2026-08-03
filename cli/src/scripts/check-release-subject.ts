/**
 * CI guard (ADR-0006 versioning discipline): on a pull request that changes any
 * template-owned path, fail unless the **pull request title** parses as a
 * Conventional Commits subject.
 *
 * Run from CI via `pnpm --filter @biffo/cli check:release-subject`, with the
 * base branch in `GITHUB_BASE_REF` and the title resolved by
 * `resolveReleaseSubject` below.
 *
 * This replaced the `core.version` bump guard when #423 made the version
 * derived. The reasoning for the swap — and why the PR title specifically, given
 * squash-merge — is in `../lib/release-subject-guard.ts`.
 *
 * Ownership is resolved by the same `isTemplateOwned` logic core upgrade uses,
 * so the guard and the sync agree on what "template-owned" means.
 *
 * ## The title is read LIVE in CI (#1187)
 *
 * Not from `github.event.pull_request.title`. That value is frozen at the
 * moment the `pull_request` event fired, and `on: pull_request` declares no
 * `types:`, so its default `[opened, synchronize, reopened]` excludes `edited`.
 * A re-run of the job replays the same stale payload. The result was that this
 * guard's **only** remedy — retitle the PR — could never turn it green without
 * pushing an unrelated commit.
 *
 * That is the same defect #1174 recorded for the closing-keywords guard, whose
 * body half was fixed in #1180; this is its second instance, in the same
 * workflow file. `resolveReleaseSubject` mirrors `resolveBody` in
 * `scripts/check-closing-keywords.mjs` deliberately, including its fail-closed
 * posture on an unreadable fetch.
 */
import { execa } from 'execa'
import { readCoreManifest } from '../lib/core-manifest.js'
import { INSTANCE_CORE_FILE, isInstanceRepo } from '../lib/core-version.js'
import { checkReleaseSubject } from '../lib/release-subject-guard.js'

/**
 * Fetch a PR's CURRENT title via the GitHub CLI. Broken out from
 * `resolveReleaseSubject` so tests can inject a fake rather than shelling out
 * to `gh`, which needs a token and a network.
 */
export async function fetchPrTitleViaGh({
  GH_TOKEN,
  PR_NUMBER,
  GH_REPO,
}: {
  GH_TOKEN: string
  PR_NUMBER: string
  GH_REPO: string
}): Promise<string> {
  const { stdout } = await execa(
    'gh',
    ['pr', 'view', PR_NUMBER, '--repo', GH_REPO, '--json', 'title', '--jq', '.title'],
    { env: { ...process.env, GH_TOKEN } },
  )
  return stdout.trim()
}

/**
 * Resolve the subject the release will actually be derived from.
 *
 * Three paths, in precedence order, and they are not interchangeable:
 *
 *   - **`PR_TITLE` set** — used as-is, no network. The local-run and test path;
 *     it must keep working with no `gh` and no token.
 *   - **`GH_TOKEN` / `PR_NUMBER` / `GH_REPO` all set** — the CI path. Fetches
 *     the title as it is *right now*, so retitling the PR and re-running the
 *     job actually clears the check (#1187).
 *   - **none set** — the head commit's subject, which is what a local run
 *     against a checkout should judge.
 *
 * A failed live fetch **throws**; it must never fall through to the git-log
 * fallback. That fallback would judge the last commit's subject instead of the
 * PR title, so a token expiry or an API blip would let a badly-titled PR pass
 * because some earlier commit happened to be well-formed — silently shipping a
 * feature as a patch, which is the exact outcome this guard exists to prevent.
 * Same reasoning as `resolveBody`'s in `check-closing-keywords.mjs`.
 */
export async function resolveReleaseSubject({
  env = process.env,
  cwd,
  fetchLiveTitle = fetchPrTitleViaGh,
}: {
  env?: NodeJS.ProcessEnv
  cwd: string
  fetchLiveTitle?: (creds: {
    GH_TOKEN: string
    PR_NUMBER: string
    GH_REPO: string
  }) => Promise<string>
}): Promise<string> {
  const explicit = env['PR_TITLE']?.trim()
  if (explicit) return explicit

  const GH_TOKEN = env['GH_TOKEN']
  const PR_NUMBER = env['PR_NUMBER']
  const GH_REPO = env['GH_REPO']
  const trio = [GH_TOKEN, PR_NUMBER, GH_REPO]

  if (trio.some(Boolean) && !trio.every(Boolean)) {
    // Only some of the three: a misconfigured workflow, not "not a PR".
    // Falling through to the git log here would be the same fail-open shape as
    // swallowing a fetch error, one step earlier.
    throw new Error(
      'GH_TOKEN, PR_NUMBER and GH_REPO must all be set together for the live PR-title fetch; got only some of them.',
    )
  }

  if (trio.every(Boolean)) {
    try {
      return await fetchLiveTitle({
        GH_TOKEN: GH_TOKEN as string,
        PR_NUMBER: PR_NUMBER as string,
        GH_REPO: GH_REPO as string,
      })
    } catch (err) {
      throw new Error(
        `could not fetch the live title of PR #${PR_NUMBER} in ${GH_REPO}: ` +
          `${(err as Error).message}`,
      )
    }
  }

  return (await execa('git', ['log', '-1', '--format=%s'], { cwd })).stdout.trim()
}

export async function runReleaseSubjectCheck(argv: string[]): Promise<void> {
  const base = process.env['GITHUB_BASE_REF'] ?? argv[0]
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
  // that is the PR title, read live in CI so a retitle can clear this check
  // (#1187); the head-commit fallback keeps the script usable locally, where
  // there is no PR.
  const subject = await resolveReleaseSubject({ cwd: root })

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
