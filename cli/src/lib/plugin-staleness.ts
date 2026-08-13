/**
 * Measures how far each `services/<name>/` vendored plugin has drifted from
 * its source (#1547). Nothing compared the two before this: an instance's CI
 * tests the copy it holds, the plugin's CI tests the source, and neither has
 * an opinion about the gap between them — `tabsii-platform`'s
 * `services/marketing/` sat 9 + 3 files behind `biffo-plugin-marketing@dev`
 * with six merged, deployed-nowhere PRs, discovered only by a hand-run
 * `git archive` + `diff -rq`.
 *
 * ## Two paths, cheapest first
 *
 * When `plugin-provenance.ts` recorded a SHA at the last install/upgrade,
 * this asks the source's default branch for its current HEAD
 * (`GitAdapter.resolveDefaultBranchSha`, no clone) and, only if that
 * differs, clones once to count the commits between them
 * (`GitAdapter.countBehind`). When no SHA is on record —
 * a plugin vendored before this feature existed, or a `--local` source that
 * was never a git checkout — it falls back to comparing file contents
 * against the source directly, the same thing a human would do with
 * `diff -rq`. That fallback cannot report a commit count (there is no
 * history to count against), so it reports a file-difference count instead;
 * both are folded into the same `behind` status because both mean the same
 * thing to the person reading the report: this copy is not what the source
 * has.
 *
 * ## Three statuses, and why "cannot tell" is not "up to date"
 *
 * `up-to-date`, `behind`, `cannot-tell` — deliberately not collapsed to two.
 * The whole failure this issue describes is silence reading as fine: a stale
 * copy does not error, it just serves old behaviour. Reporting a network
 * failure, an unauthenticated clone, or an unresolvable source as
 * `up-to-date` would reproduce exactly that failure inside the tool built to
 * catch it. See `exitCodeForStaleness` for how this maps to an exit code
 * when a caller wants one.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { GitAdapter } from '../adapters/git/index.js'
import type { RegistryAdapter } from '../adapters/registry/index.js'
import { isGitWorkingTree, listGitFiles, LOCAL_COPY_EXCLUDES } from './plugin-source-copy.js'
import {
  PLUGIN_PROVENANCE_FILENAME,
  readProvenance,
  type PluginProvenance,
} from './plugin-provenance.js'

export type PluginStalenessStatus = 'up-to-date' | 'behind' | 'cannot-tell'

export interface PluginStalenessResult {
  name: string
  status: PluginStalenessStatus
  /** Set only on the provenance (cheap) path, when `status` is `behind`. */
  commitsBehind?: number
  /** Set only on the content-diff (fallback) path, when `status` is `behind`
   * or the comparison succeeded and found nothing (`up-to-date`). */
  filesDiffering?: number
  method: 'provenance' | 'content-diff' | 'unresolvable'
  /** Human-readable explanation — always present, since `cannot-tell` is
   * meaningless to a reader without a reason. */
  detail: string
}

/**
 * `git` is the same `GitAdapter` install/upgrade already depend on
 * (`resolveDefaultBranchSha`, `cloneToTemp`, `cloneForEditing`, `countBehind`,
 * `cleanup`) — reused rather than a second, standalone set of `execa` calls,
 * so a test can mock exactly one git surface for the whole plugin subsystem
 * and this module's own tests never need real network access.
 */
export interface PluginStalenessDeps {
  registry: RegistryAdapter
  git: GitAdapter
}

/** Directories under `services/` that are never a vendored plugin. */
function discoverVendoredPlugins(servicesDir: string): string[] {
  if (!existsSync(servicesDir)) return []
  return readdirSync(servicesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && e.name !== 'api')
    .map((e) => e.name)
    .filter((name) => existsSync(join(servicesDir, name, 'biffo.plugin.json')))
    .sort()
}

/**
 * Checks every vendored plugin under `<cwd>/services/`. A registry lookup is
 * made at most once, lazily, and only for plugins that actually need it as a
 * fallback source resolver (provenance with a usable origin never needs one).
 */
export async function checkPluginStaleness(
  cwd: string,
  deps: PluginStalenessDeps,
): Promise<PluginStalenessResult[]> {
  const servicesDir = join(cwd, 'services')
  const names = discoverVendoredPlugins(servicesDir)

  let registryRepoByName: Map<string, string> | null = null
  const resolveRegistryRepo = async (name: string): Promise<string | null> => {
    if (registryRepoByName === null) {
      registryRepoByName = new Map()
      try {
        const reg = await deps.registry.fetchRegistry()
        for (const entry of reg.plugins) registryRepoByName.set(entry.name, entry.repo)
      } catch {
        // No fallback available; leave the map empty rather than fail every
        // plugin's check over a registry that happens to be unreachable —
        // each plugin's own provenance may still be enough on its own.
      }
    }
    return registryRepoByName.get(name) ?? null
  }

  const results: PluginStalenessResult[] = []
  for (const name of names) {
    results.push(await checkOnePlugin(join(servicesDir, name), name, resolveRegistryRepo, deps.git))
  }
  return results
}

async function checkOnePlugin(
  pluginDir: string,
  name: string,
  resolveRegistryRepo: (name: string) => Promise<string | null>,
  git: GitAdapter,
): Promise<PluginStalenessResult> {
  const provenance = readProvenance(pluginDir)

  if (provenance.status === 'invalid') {
    return {
      name,
      status: 'cannot-tell',
      method: 'unresolvable',
      detail: `provenance file is unreadable — ${provenance.reason}`,
    }
  }

  const record = provenance.status === 'present' ? provenance.record : null

  if (record?.inTree) {
    return {
      name,
      status: 'cannot-tell',
      method: 'unresolvable',
      detail: `installed --local straight into services/${name}/ (in-tree) — there is no external plugin repo to compare against`,
    }
  }

  // The cheap path: a SHA was recorded and the origin is something fetchable.
  if (record?.sha && isFetchableUrl(record.origin)) {
    return checkViaProvenance(name, record, record.origin, git)
  }

  // Fallback source resolution: an origin recorded but not fetchable (a local
  // path), or no provenance at all — try the registry by plugin name.
  const localOrigin =
    record && !isFetchableUrl(record.origin) && existsSync(record.origin) ? record.origin : null

  if (localOrigin) {
    return checkViaContentDiff(name, pluginDir, localOrigin, { isLocalDir: true }, git)
  }

  const registryRepo = await resolveRegistryRepo(name)
  if (!registryRepo) {
    return {
      name,
      status: 'cannot-tell',
      method: 'unresolvable',
      detail: record
        ? `provenance records origin '${record.origin}', which is neither a reachable git URL nor a local ` +
          `directory that still exists, and '${name}' was not found in the plugin registry either`
        : `no provenance recorded (vendored before #1547, or an unreachable registry) and '${name}' was ` +
          `not found in the plugin registry — nothing to compare against`,
    }
  }

  if (record?.sha) {
    // Origin wasn't fetchable (e.g. a stale local path), but the registry
    // resolved a real repo for this plugin name — prefer the cheap path
    // against that.
    return checkViaProvenance(name, record, registryRepo, git)
  }

  return checkViaContentDiff(name, pluginDir, registryRepo, { isLocalDir: false }, git)
}

function isFetchableUrl(origin: string): boolean {
  return /^(https?|git|ssh):\/\//.test(origin) || /^[^/\\]+@[^:]+:/.test(origin)
}

async function checkViaProvenance(
  name: string,
  record: PluginProvenance,
  repoUrl: string,
  git: GitAdapter,
): Promise<PluginStalenessResult> {
  const remoteHeadSha = await git.resolveDefaultBranchSha(repoUrl)
  if (!remoteHeadSha) {
    return {
      name,
      status: 'cannot-tell',
      method: 'unresolvable',
      detail: `could not reach ${repoUrl} (network or authentication failure)`,
    }
  }

  if (remoteHeadSha === record.sha) {
    return {
      name,
      status: 'up-to-date',
      method: 'provenance',
      detail: `matches ${repoUrl}'s default branch (${shortSha(remoteHeadSha)})`,
    }
  }

  // Different SHAs — clone (full history, needed to count) to find out how
  // far behind, and to distinguish real drift from a rebased/force-pushed
  // history the recorded SHA no longer belongs to. `cloneForEditing` (not
  // `cloneToTemp`) deliberately: it keeps `.git`, which `countBehind` needs.
  let clone: string
  try {
    clone = await git.cloneForEditing(repoUrl, 'biffo-plugin-staleness-full')
  } catch {
    return {
      name,
      status: 'cannot-tell',
      method: 'unresolvable',
      detail: `could not clone ${repoUrl} to count commits behind (network or authentication failure)`,
    }
  }
  try {
    const commitsBehind = await git.countBehind(clone, record.sha!, 'HEAD')
    if (commitsBehind === null) {
      return {
        name,
        status: 'cannot-tell',
        method: 'unresolvable',
        detail:
          `recorded commit ${shortSha(record.sha!)} was not found in ${repoUrl}'s history ` +
          '(rebased or force-pushed?) — cannot count commits behind',
      }
    }
    if (commitsBehind === 0) {
      return {
        name,
        status: 'up-to-date',
        method: 'provenance',
        detail: `matches ${repoUrl}'s default branch (${shortSha(remoteHeadSha)})`,
      }
    }
    return {
      name,
      status: 'behind',
      commitsBehind,
      method: 'provenance',
      detail: `${commitsBehind} commit(s) behind ${repoUrl}'s default branch`,
    }
  } finally {
    git.cleanup(clone)
  }
}

async function checkViaContentDiff(
  name: string,
  pluginDir: string,
  sourceDir: string,
  opts: { isLocalDir: boolean },
  git: GitAdapter,
): Promise<PluginStalenessResult> {
  let cloneDir: string | null = null
  let effectiveSourceDir = sourceDir

  if (!opts.isLocalDir) {
    try {
      cloneDir = await git.cloneToTemp(sourceDir, 'biffo-plugin-staleness-content')
    } catch {
      return {
        name,
        status: 'cannot-tell',
        method: 'unresolvable',
        detail: `could not clone ${sourceDir} for a content comparison (network or authentication failure)`,
      }
    }
    effectiveSourceDir = cloneDir
  }

  try {
    const filesDiffering = await countDifferingFiles(effectiveSourceDir, pluginDir)
    const originDescription = opts.isLocalDir ? effectiveSourceDir : sourceDir
    if (filesDiffering === 0) {
      return {
        name,
        status: 'up-to-date',
        method: 'content-diff',
        filesDiffering: 0,
        detail: `byte-identical to ${originDescription} (no provenance recorded, so an exact commit could not be named)`,
      }
    }
    return {
      name,
      status: 'behind',
      filesDiffering,
      method: 'content-diff',
      detail:
        `${filesDiffering} file(s) differ from ${originDescription} ` +
        '(no provenance recorded, so an exact commit count could not be determined)',
    }
  } finally {
    if (cloneDir) git.cleanup(cloneDir)
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/**
 * Counts files that differ, are missing, or are extra between `sourceDir`
 * (the plugin's real source) and `pluginDir` (the vendored copy) — the same
 * thing `diff -rq` reports, minus the provenance file itself, which is
 * instance-owned bookkeeping this feature added and must never be compared
 * against a source that has never heard of it (see plugin-provenance.ts).
 */
async function countDifferingFiles(sourceDir: string, pluginDir: string): Promise<number> {
  const sourceFiles = await sourceFileList(sourceDir)
  const vendorFiles = vendorFileList(pluginDir)

  const allPaths = new Set([...sourceFiles, ...vendorFiles])
  let differing = 0
  for (const relPath of allPaths) {
    if (relPath === PLUGIN_PROVENANCE_FILENAME) continue
    const inSource = sourceFiles.has(relPath)
    const inVendor = vendorFiles.has(relPath)
    if (!inSource || !inVendor) {
      differing++
      continue
    }
    const a = readFileSync(join(sourceDir, relPath))
    const b = readFileSync(join(pluginDir, relPath))
    if (!a.equals(b)) differing++
  }
  return differing
}

/**
 * A local `--local` source (still on disk, `.git` intact) gets the precise,
 * `.gitignore`-aware file list `listGitFiles` provides. A registry source
 * reached here via `git.cloneToTemp` no longer has `.git` at all — that
 * method strips it deliberately (see its own docstring: the result is meant
 * to become plain vendored files) — so it falls back to the denylist walk,
 * same approximation `copyPluginSource` itself accepts for a non-git local
 * source. Acceptable here specifically because this whole function only
 * runs when there is no provenance to trust in the first place — it is
 * already the fallback of a fallback.
 */
async function sourceFileList(dir: string): Promise<Set<string>> {
  if (await isGitWorkingTree(dir)) {
    return new Set(await listGitFiles(dir))
  }
  return new Set(walkExcluding(dir, dir, LOCAL_COPY_EXCLUDES))
}

function vendorFileList(dir: string): Set<string> {
  return new Set(walkExcluding(dir, dir, LOCAL_COPY_EXCLUDES))
}

function walkExcluding(root: string, dir: string, excludes: Set<string>): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (excludes.has(entry) || entry === '.git') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...walkExcluding(root, full, excludes))
    } else {
      out.push(relative(root, full))
    }
  }
  return out
}

/** `0` — every plugin is up to date; `1` — at least one is behind, and none
 * are worse than that; `2` — at least one could not be determined, which
 * outranks `behind` the same way "cannot tell" outranks every other verdict
 * throughout this estate's scripts (see `scripts/claim.sh`'s own comment on
 * why 2 is deliberately not 0). Never conflated with `up-to-date`. */
export function exitCodeForStaleness(results: PluginStalenessResult[]): number {
  if (results.some((r) => r.status === 'cannot-tell')) return 2
  if (results.some((r) => r.status === 'behind')) return 1
  return 0
}

export function formatStalenessReport(results: PluginStalenessResult[]): string {
  if (results.length === 0) {
    return '  No vendored plugins under services/ — nothing to check.'
  }
  const lines: string[] = ['']
  for (const r of results) {
    const icon = r.status === 'up-to-date' ? '✓' : r.status === 'behind' ? '⚠' : '?'
    lines.push(`  ${icon} ${r.name}: ${labelFor(r.status)} — ${r.detail}`)
  }
  lines.push('')
  return lines.join('\n')
}

function labelFor(status: PluginStalenessStatus): string {
  switch (status) {
    case 'up-to-date':
      return 'up to date'
    case 'behind':
      return 'BEHIND'
    case 'cannot-tell':
      return 'CANNOT TELL'
  }
}
