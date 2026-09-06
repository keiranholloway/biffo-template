import { execa } from './exec.js'

/**
 * Where the real template lives, for the one question `core-ownership-guard.ts`
 * cannot answer from `core-manifest.json` alone: does biffo-template actually
 * ship this path, or does it merely fall under a declared template-owned
 * prefix (#1912, class #1362 instance #8)?
 *
 * `GitHubAdapter` (adapters/source-control/github/index.ts) carries its own
 * `templateOwner`/`templateRepo` defaults, for an unrelated purpose (which
 * repo `biffo init` scaffolds a new instance FROM). Not unified with this
 * constant — that would widen this fix's blast radius into an already-working,
 * unrelated adapter for a one-line saving.
 */
export const TEMPLATE_UPSTREAM_OWNER = 'keiranholloway'
export const TEMPLATE_UPSTREAM_REPO = 'biffo-template'
export const TEMPLATE_UPSTREAM_BRANCH = 'dev'

export interface GitCommandResult {
  stdout: string
  exitCode: number | null
}

export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitCommandResult>

const defaultRunner: GitCommandRunner = async (args, cwd) => {
  // A short, explicit timeout — not `exec.ts`'s 15-minute default. This is a
  // best-effort, single-branch fetch that a caller falls back gracefully from
  // (see `fetchTemplateShippedPaths`'s own doc), not a step anything should
  // sit and wait 15 minutes for before giving up. #1693 is the reason every
  // subprocess in this CLI has a *finite* timeout at all; this one is finite
  // and short on purpose, because "best-effort" only means something if the
  // effort ends quickly.
  const result = await execa('git', args, { cwd, reject: false, timeout: 15_000 })
  return { stdout: String(result.stdout ?? ''), exitCode: result.exitCode ?? null }
}

/**
 * The template's real shipped file set, read live from its own `dev` branch —
 * ADR-0006's own moving definition of "what the template currently ships" (the
 * same branch `biffo core upgrade` treats as the latest target absent an
 * explicit `--to`). A shallow, single-branch `git fetch` over plain HTTPS:
 * biffo-template is public, so this needs no token, unlike the cross-repo
 * GitHub *API* reads `check-distribution-remote-state.ts` needs a
 * `BIFFO_GITHUB_TOKEN` for — this is a different, lighter mechanism, chosen
 * because a per-commit or per-PR check has no business depending on a secret
 * being configured in every instance that ever wants a correct answer here.
 *
 * Returns `null` — never an empty set — when the fetch or the tree read fails
 * for ANY reason: offline, DNS failure, the 15s timeout, a sandboxed CI runner
 * with no network egress. Callers MUST treat `null` as "could not tell", never
 * as "the template ships nothing" — collapsing the two would turn a network
 * hiccup into every template-owned path reading as an orphan and every
 * legitimate block silently disappearing, which is the exact fail-open shape
 * (class #1363) this fix must not introduce while closing #1362 instance #8.
 */
export async function fetchTemplateShippedPaths(
  repoRoot: string,
  runner: GitCommandRunner = defaultRunner,
): Promise<Set<string> | null> {
  const url = `https://github.com/${TEMPLATE_UPSTREAM_OWNER}/${TEMPLATE_UPSTREAM_REPO}.git`

  let fetched: GitCommandResult
  try {
    fetched = await runner(
      ['fetch', '--depth', '1', '--quiet', url, TEMPLATE_UPSTREAM_BRANCH],
      repoRoot,
    )
  } catch {
    return null
  }
  if (fetched.exitCode !== 0) return null

  let tree: GitCommandResult
  try {
    tree = await runner(['ls-tree', '-r', '--name-only', 'FETCH_HEAD'], repoRoot)
  } catch {
    return null
  }
  if (tree.exitCode !== 0) return null

  const paths = tree.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  // An exit code of 0 with zero paths is indistinguishable from "the fetch
  // silently returned nothing" (e.g. FETCH_HEAD not actually updated in some
  // git version/config) — never plausible for a real template, so treat it the
  // same as any other failure to determine rather than as "ships nothing".
  return paths.length > 0 ? new Set(paths) : null
}
