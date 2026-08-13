/**
 * Provenance for a vendored plugin at `services/<name>/` — where the copy
 * came from, and (when knowable) exactly which commit, so "how stale is
 * this?" can be answered without cloning both repos and diffing by hand
 * (#1547). Every path that writes `services/<name>/` — `plugin install`
 * (registry and `--local`) and `plugin upgrade` (registry and `--local`) —
 * calls into this module right after the copy.
 *
 * ## Why a dedicated file, not `biffo.plugin.json`
 *
 * `biffo.plugin.json` is the plugin repo's OWN manifest, copied verbatim by
 * `copyPluginSource`/`cpSync`. Writing provenance into it would mutate a file
 * the source repo also ships — permanent, self-inflicted drift against the
 * very thing staleness is trying to measure, and it would poison the content-
 * diff fallback in `plugin-staleness.ts` (a manifest with a provenance block
 * stapled on could never byte-match the untouched source, even when nothing
 * else differs). `PLUGIN_PROVENANCE_FILENAME` therefore lives beside it as
 * its own file, and `plugin-staleness.ts`'s content-diff fallback excludes it
 * by name for the identical reason.
 *
 * ## Honesty over fabrication
 *
 * A `--local` source is not guaranteed to be a git checkout at all —
 * `biffo plugin create` does not `git init` one, and nothing requires a
 * directory passed to `--local` to be a repo. `resolveLocalProvenance`
 * reflects that: `sha`/`ref` come back `null` rather than invented. The
 * registry path can't read a SHA off disk either, for a different reason —
 * `GitAdapter.cloneToTemp` strips `.git` from the clone before install/
 * upgrade ever see it (see its own docstring) — so `resolveRegistryProvenance`
 * takes the SHA as a parameter, resolved by the caller via `GitAdapter.
 * resolveDefaultBranchSha` (a `git ls-remote`, no clone needed) rather than
 * reaching into a temp clone that no longer carries the answer.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'

export const PLUGIN_PROVENANCE_FILENAME = '.biffo-plugin-provenance.json'

export interface PluginProvenance {
  /** Where the copy came from: a repo URL, or a local filesystem path. */
  origin: string
  /** The branch resolved at write time, or null when unknown (a non-git
   * local source, a detached HEAD, or the registry path — see module docs). */
  ref: string | null
  /** The resolved commit SHA at write time, or null when it could not be
   * determined. Never fabricated. */
  sha: string | null
  /** ISO 8601 timestamp of when this record was written. */
  recordedAt: string
  /** True when `origin` IS `services/<name>/` itself — `--local` pointed at
   * the already-installed copy (`inTreeSource` in plugin-install.ts /
   * plugin-upgrade.ts), so there is no external source to compare against at
   * all. See `inTreePluginProvenance`. */
  inTree: boolean
}

function isPluginProvenance(value: unknown): value is PluginProvenance {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['origin'] === 'string' &&
    (typeof v['ref'] === 'string' || v['ref'] === null) &&
    (typeof v['sha'] === 'string' || v['sha'] === null) &&
    typeof v['recordedAt'] === 'string' &&
    typeof v['inTree'] === 'boolean'
  )
}

export type ReadProvenanceResult =
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'present'; record: PluginProvenance }

/**
 * Reads `services/<name>/.biffo-plugin-provenance.json`. Never throws.
 *
 * `absent` covers both a plugin vendored before this feature existed and a
 * genuinely fresh in-tree scaffold — either way, staleness has nothing
 * recorded to trust and must fall back to a content comparison.
 * `invalid` is kept distinct from `absent` on purpose: a present-but-corrupt
 * file is a different, worse condition than "never recorded", and collapsing
 * the two would let staleness silently degrade to the content-diff fallback
 * without ever saying why.
 */
export function readProvenance(pluginDir: string): ReadProvenanceResult {
  const path = join(pluginDir, PLUGIN_PROVENANCE_FILENAME)
  if (!existsSync(path)) return { status: 'absent' }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return {
      status: 'invalid',
      reason: `could not parse ${PLUGIN_PROVENANCE_FILENAME}: ${(err as Error).message}`,
    }
  }
  if (!isPluginProvenance(parsed)) {
    return {
      status: 'invalid',
      reason: `${PLUGIN_PROVENANCE_FILENAME} does not have the expected shape`,
    }
  }
  return { status: 'present', record: parsed }
}

/** Writes the provenance record into an already-copied `services/<name>/`. */
export function writePluginProvenance(pluginDir: string, record: PluginProvenance): void {
  writeFileSync(join(pluginDir, PLUGIN_PROVENANCE_FILENAME), `${JSON.stringify(record, null, 2)}\n`)
}

/**
 * Chooses what to actually persist: `next`, unless it is identical to
 * `previous` in everything but `recordedAt`, in which case `previous` itself
 * is returned so the file's bytes — including its timestamp — do not change.
 *
 * `plugin upgrade --local` deliberately treats a byte-identical refresh as
 * nothing-to-commit (see its own docstring: `git commit` would otherwise
 * fail on an empty diff). Writing a fresh `recordedAt` unconditionally on
 * every run would defeat that — the provenance file would touch on every
 * refresh even when nothing else did, turning a legitimate no-op into a
 * commit.
 *
 * Takes `previous` as a parameter rather than reading it off disk itself,
 * because both non-in-tree write paths (`plugin upgrade`'s registry branch,
 * and its `--local` branch when the source is not already the installed
 * copy) delete and recreate `services/<name>/` wholesale *before* this
 * module is ever called — by the time a write happens, the previous
 * provenance file, if any, is already gone. Callers must read it before that
 * deletion and pass it in here; see the call sites in plugin-install.ts /
 * plugin-upgrade.ts.
 */
export function reconcileProvenance(
  previous: ReadProvenanceResult,
  next: PluginProvenance,
): PluginProvenance {
  if (previous.status === 'present' && sameProvenance(previous.record, next)) return previous.record
  return next
}

function sameProvenance(a: PluginProvenance, b: PluginProvenance): boolean {
  return a.origin === b.origin && a.ref === b.ref && a.sha === b.sha && a.inTree === b.inTree
}

/**
 * Provenance for a refresh where `--local` pointed straight at
 * `services/<name>/` (the `inTreeSource` case in both plugin-install.ts and
 * plugin-upgrade.ts) — there is no separate upstream checkout, ever.
 * Recording a SHA here would mean comparing the vendored copy to itself,
 * which always reads as "up to date" and hides exactly the condition this
 * feature exists to surface — so this deliberately never carries one.
 */
export function inTreePluginProvenance(relTargetDir: string): PluginProvenance {
  return {
    origin: relTargetDir,
    ref: null,
    sha: null,
    recordedAt: new Date().toISOString(),
    inTree: true,
  }
}

/**
 * Resolves provenance from a local, on-disk `--local` source directory that
 * is NOT the in-tree case — install/upgrade's own working copy, still on
 * disk at call time. Honest by construction: a source that is not itself a
 * git working tree has no SHA/ref to record, and this returns `null` for
 * both rather than fabricating one.
 */
export async function resolveLocalProvenance(
  sourceDir: string,
  origin: string,
): Promise<PluginProvenance> {
  const recordedAt = new Date().toISOString()
  if (!(await isGitWorkingTree(sourceDir))) {
    return { origin, ref: null, sha: null, recordedAt, inTree: false }
  }
  const sha = await tryGit(sourceDir, ['rev-parse', 'HEAD'])
  const rawRef = await tryGit(sourceDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  // A detached HEAD reports its own literal name ("HEAD") back from
  // --abbrev-ref, which is not a real ref anyone could re-resolve later.
  const ref = rawRef && rawRef !== 'HEAD' ? rawRef : null
  return { origin, ref, sha, recordedAt, inTree: false }
}

/**
 * Builds provenance for a plugin cloned from the registry. Takes `sha`
 * rather than resolving it itself: by the time install/upgrade get to copy
 * `entry.repo`'s temp clone, `GitAdapter.cloneToTemp` has already stripped
 * its `.git` (see that method's own docstring — the clone is meant to become
 * plain vendored files, not a nested repo), so there is nothing on disk left
 * to read a SHA from, and the caller already has `GitAdapter` (an injected,
 * mockable dependency) to ask the remote directly via
 * `resolveDefaultBranchSha` — reaching for a second, ungoverned `execa` call
 * here would both duplicate that logic and make every install/upgrade test
 * that reaches this line depend on real network access.
 *
 * Accepted race, inherent to any SHA captured this way: the remote's default
 * branch can move in the window between the clone actually used for the
 * copy and the `resolveDefaultBranchSha` call the caller made. That window
 * is seconds; the alternative is a second full clone purely to read one
 * commit, which is a worse trade for a value that is already advisory.
 */
export function resolveRegistryProvenance(repoUrl: string, sha: string | null): PluginProvenance {
  return { origin: repoUrl, ref: null, sha, recordedAt: new Date().toISOString(), inTree: false }
}

async function isGitWorkingTree(dir: string): Promise<boolean> {
  try {
    await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })
    return true
  } catch {
    return false
  }
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execa('git', args, { cwd })
    return stdout.trim() || null
  } catch {
    return null
  }
}
