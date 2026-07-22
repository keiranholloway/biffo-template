import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, parse as parsePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/**
 * Core versioning primitives for ADR-0006 (Core Upgrade and Template Sync).
 *
 * Where the version lives, on each side of the template/instance boundary:
 *
 *   - **The template** has no file naming its version. Since #423 it is derived:
 *     the highest `core-v*` tag, bumped at release time by the conventional type
 *     of the commit being released (`../scripts/sync-core-tag.ts`). Nothing in
 *     the tree names a version, so nothing can name a stale or already-released
 *     one — the fault behind #294, #342 and #422.
 *   - **An instance** records the version it was initialised from, and later
 *     upgraded to, in `biffo.core.json` at its root. `biffo init` writes and
 *     commits it, and `biffo core upgrade` rewrites it.
 *   - **This CLI** carries its version in its own `package.json`, stamped from
 *     the tag at publish (`publish-cli.yml`). The CLI's version IS the core
 *     version — one number, no mapping table (ADR-0006).
 *
 * `core.version` survives only as a legacy fallback. Instances scaffolded before
 * #423 inherited a copy through GitHub template generation, and it is user-owned
 * (absent from both lists in `core-manifest.json`), so no upgrade removes it.
 * Nothing treats it as authoritative — `biffo.core.json` wins every lookup — but
 * `deploy.ts` and `core-upgrade.ts` still read it when nothing better is present
 * at the ref or checkout in hand. See #434.
 *
 * `biffo core status` compares the instance's recorded version against the
 * version this CLI ships with.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

const CoreManifestSchema = z.object({
  version: z.string().regex(SEMVER, 'must be a semver, e.g. 1.2.3'),
})

export const CORE_VERSION_FILE = 'core.version'
export const INSTANCE_CORE_FILE = 'biffo.core.json'

/**
 * Is `repoRoot` an instance rather than the template?
 *
 * `biffo.core.json` is written at `biffo init` and never present in the
 * template, so its presence is the discriminator. `core.version` is *not*: the
 * template no longer has one at all (#423), and instances scaffolded before that
 * still carry an inherited copy.
 *
 * This matters beyond the CLI's own behaviour, because `cli/` is template-owned:
 * `biffo core upgrade` copies it — tests included — into every instance. A check
 * that asserts on the template's own repo layout therefore arrives in a repo
 * that legitimately has a different one, and turns its CI red on files it never
 * wrote (#367). Such a check must gate on this (`describe.skipIf`), and the
 * probe lives here so there is one definition of it rather than one per caller.
 */
export function isInstanceRepo(repoRoot: string): boolean {
  return existsSync(join(repoRoot, INSTANCE_CORE_FILE))
}

/** Parse a `major.minor.patch` string into a numeric tuple, throwing on any
 * other shape (no pre-release/build metadata — core versions are plain semver). */
export function parseCoreVersion(raw: string): [number, number, number] {
  const match = SEMVER.exec(raw.trim())
  if (!match) {
    throw new Error(`Invalid core version ${JSON.stringify(raw)}: expected semver like 1.2.3`)
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compareCoreVersions(a: string, b: string): -1 | 0 | 1 {
  const [aMaj, aMin, aPat] = parseCoreVersion(a)
  const [bMaj, bMin, bPat] = parseCoreVersion(b)
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1
  if (aMin !== bMin) return aMin < bMin ? -1 : 1
  if (aPat !== bPat) return aPat < bPat ? -1 : 1
  return 0
}

/** Read and validate a `core.version` file, returning the trimmed version. */
export function readCoreVersionFile(path: string): string {
  const raw = readFileSync(path, 'utf8').trim()
  parseCoreVersion(raw) // validate
  return raw
}

/**
 * Walk up from `startDir` looking for a `core.version` file, returning its path
 * or null. Used to locate the version this CLI ships with: from the built
 * `dist/` (or `src/` in dev) it finds the nearest `core.version` up the tree —
 * the template repo root in the monorepo.
 */
export function findCoreVersionUpward(startDir: string): string | null {
  let dir = startDir
  // parsePath(dir).root is the filesystem root ('/' or 'C:\\'); stop there.
  for (;;) {
    const candidate = join(dir, CORE_VERSION_FILE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir || dir === parsePath(dir).root) return null
    dir = parent
  }
}

/**
 * The core version this CLI ships with (the "latest available" version an
 * instance can upgrade to).
 *
 * Resolved by walking up from this module's location to the nearest
 * `core.version`. Two arrangements both satisfy that single walk:
 *
 *  - **Template checkout** (development): `cli/dist/` or `cli/src/` walks up to
 *    the repo root's `core.version`.
 *  - **Published `biffo` package** (npm): nothing exists above
 *    `node_modules/biffo/`, so the package ships its own copy of `core.version`
 *    beside `dist/`. It is produced by `cli/scripts/sync-core-version.mjs` from
 *    the `prepack` hook and listed in package.json `files`; the walk finds it
 *    one level up from `dist/`. See `core-version-packaging.test.ts`, which
 *    guards both the `files` entry and the hook.
 */
export function getLatestCoreVersion(fromDir?: string): string {
  const start = fromDir ?? dirname(fileURLToPath(import.meta.url))

  // Installed from npm: the package version IS the core version (ADR-0006 —
  // one number, no mapping table), stamped at publish from the tag being
  // released. Reading it needs no file beside dist/ and no git.
  const fromPackage = versionFromPackageJson(start)
  if (fromPackage) return fromPackage

  // A template checkout: the highest core-v* tag. Walking up finds the repo
  // root, which is a git repo; the published package never is.
  const fromTags = latestCoreVersionFromTags(findRepoRoot(start) ?? start)
  if (fromTags) return fromTags

  // Anything older that still carries the retired file.
  const path = findCoreVersionUpward(start)
  if (path) return readCoreVersionFile(path)

  throw new Error(
    `Could not determine the core version above ${start}: no package.json version, no core-v* ` +
      `tag, and no ${CORE_VERSION_FILE}. This CLI build is missing its version identity.`,
  )
}

/**
 * The nearest ancestor `package.json` carrying a semver `version`.
 *
 * In the published package that is `@biffo/cli`'s own, whose version is the
 * core version. In a template checkout the nearest one is `cli/package.json`,
 * which is a placeholder `0.0.0` — rejected here so the checkout falls through
 * to its tags rather than reporting a version that means nothing.
 */
function versionFromPackageJson(startDir: string): string | null {
  let dir = startDir
  for (;;) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }
        if (typeof raw.version === 'string' && SEMVER.test(raw.version) && raw.version !== '0.0.0') {
          return raw.version
        }
      } catch {
        /* unreadable or not JSON — keep walking */
      }
      return null
    }
    const parent = dirname(dir)
    if (parent === dir || dir === parsePath(dir).root) return null
    dir = parent
  }
}

/** Nearest ancestor directory containing `.git` — the repo root, or null. */
function findRepoRoot(startDir: string): string | null {
  let dir = startDir
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir || dir === parsePath(dir).root) return null
    dir = parent
  }
}

/**
 * The core version an instance repo is currently on.
 *
 * `biffo.core.json` is the authority. `biffo init` writes and commits it at
 * scaffold time (see the seed files in `../commands/init.ts`), and `biffo core
 * upgrade` rewrites it on every upgrade, so it records what this instance
 * actually received rather than what some inherited file happens to say.
 *
 * Resolution prefers that record and falls back to an inherited `core.version`
 * only for instances that predate it:
 *   1. `<cwd>/biffo.core.json` if present (any instance scaffolded or upgraded
 *      by a CLI that writes it);
 *   2. otherwise `<cwd>/core.version` — a copy inherited through GitHub template
 *      generation before #423 removed the file from the template. User-owned, so
 *      no upgrade deletes it, and nothing writes it any more (#434);
 *   3. otherwise null (not a Biffo instance).
 *
 * Throws when `biffo.core.json` is present but malformed, so a corrupt record is
 * surfaced rather than silently treated as "no version".
 */
export function readInstanceCoreVersion(cwd: string): string | null {
  const path = join(cwd, INSTANCE_CORE_FILE)
  if (!existsSync(path)) {
    const inherited = join(cwd, CORE_VERSION_FILE)
    return existsSync(inherited) ? readCoreVersionFile(inherited) : null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${INSTANCE_CORE_FILE} is not valid JSON: ${(err as Error).message}`)
  }
  const result = CoreManifestSchema.safeParse(parsed)
  if (!result.success) {
    const detail = result.error.issues[0]?.message ?? 'unexpected shape'
    throw new Error(`${INSTANCE_CORE_FILE} is invalid: ${detail}`)
  }
  return result.data.version
}

/**
 * Serialise a `biffo.core.json` body recording `version`, validating the semver
 * first. Shared by `writeInstanceCoreVersion` (local filesystem write, used by
 * `biffo core upgrade`) and `biffo init`, which commits the same bytes into the
 * freshly scaffolded repo over the GitHub API rather than to disk.
 */
export function serializeInstanceCoreVersion(version: string): string {
  parseCoreVersion(version) // validate
  return `${JSON.stringify({ version }, null, 2)}\n`
}

/** Write `<cwd>/biffo.core.json` recording `version` — used by an upgrade to
 * bump the instance's recorded core version in the same commit. */
export function writeInstanceCoreVersion(cwd: string, version: string): void {
  writeFileSync(join(cwd, INSTANCE_CORE_FILE), serializeInstanceCoreVersion(version))
}

/**
 * The highest `core-v*` tag in a template checkout — the template's current
 * core version (issue #423).
 *
 * ## Why the tag, and not a file
 *
 * `core.version` used to be a tracked file every template-owned PR had to bump.
 * One global counter plus branch protection made a conflict between concurrent
 * PRs certain, and the attempt to derive it in the release job (#425) failed for
 * a reason no amount of care would have avoided: `main` refuses direct pushes,
 * so nothing running in CI can write the file at all.
 *
 * A tag needs no push to a protected branch, cannot conflict between PRs
 * because no PR creates one, and already IS the release — `core-v<version>` is
 * what `publish-cli.yml` fires on and what `biffo core upgrade` materialises
 * trees from. Making it the source of truth removes a second representation of
 * something git was already recording.
 *
 * Returns null when the repo has no core tags at all (a fresh template, before
 * its first release), so callers can fall back rather than crash.
 *
 * ## Why it fetches first
 *
 * Tags do not arrive with `git pull`. A checkout can be perfectly up to date on
 * `main` and still not have the newest `core-v*`, because the release job
 * creates it after the merge — which is exactly the state a template checkout
 * is in right after pulling. Reading local tags alone then resolves one version
 * behind, silently: the upgrade targets the wrong version and every instance
 * lands short of the release.
 *
 * That is not hypothetical. It happened on the first sync after this function
 * shipped: `core-v0.59.0` existed on the remote, not locally, and two instances
 * were offered 0.58.1. The file this replaced never had the problem, because
 * `git pull` keeps a tracked file current.
 *
 * The fetch is best-effort — offline, or a repo with no remote, still resolves
 * from whatever tags are local. `materializeTemplateAtTag` already does the
 * same when a tag it needs is missing.
 */
export function latestCoreVersionFromTags(
  repo: string,
  git: TagRunner = defaultTagRunner,
): string | null {
  try {
    git(['-C', repo, 'fetch', '--tags', '--quiet'])
  } catch {
    /* offline, or no remote — fall through to whatever is local */
  }
  let out: string
  try {
    out = git(['-C', repo, 'tag', '--list', 'core-v*'])
  } catch {
    return null
  }
  const versions = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(CORE_TAG_PREFIX))
    .map((tag) => tag.slice(CORE_TAG_PREFIX.length))
    // A tag that is not a plain semver is not a core release; ignore rather
    // than throw, so one stray tag cannot break every upgrade.
    .filter((v) => SEMVER.test(v))
  if (versions.length === 0) return null
  return versions.sort(compareCoreVersions).at(-1) ?? null
}

/** Prefix of every core release tag. */
export const CORE_TAG_PREFIX = 'core-v'

export type TagRunner = (args: string[]) => string

const defaultTagRunner: TagRunner = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
