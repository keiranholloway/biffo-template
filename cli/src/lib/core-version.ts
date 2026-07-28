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

/**
 * A core migration this instance has deliberately chosen not to carry (#735).
 *
 * `reason` is required, on the same principle `biffo.divergence.json` applies to
 * declared drift: a decline with nothing recorded about why is a decision nobody
 * can review later, and the next upgrade re-litigates it from scratch. `upstream`
 * is optional because — unlike declared divergence — a decline is often
 * temporary: #670 fixed the migration tabsii declined, at which point the entry
 * should simply be deleted rather than tracked to closure.
 */
const DeclinedMigrationSchema = z.object({
  /** The *template's* filename for the migration, e.g. `0010_add_organizations.py`. */
  file: z
    .string({ required_error: 'file is required — it must name a template migration' })
    .min(1, 'file is required — it must name a template migration'),
  // `required_error` as well as `min(1)`: zod reports a bare "Required" for an
  // absent key, which would lose the guidance in the exact case most likely to
  // occur — someone adding an entry and omitting the field.
  reason: z
    .string({ required_error: 'reason is required — a decline nobody can review is drift' })
    .min(1, 'reason is required — a decline nobody can review is drift'),
  /** Optional `owner/repo#123` recording where the decline is being resolved. */
  upstream: z.string().optional(),
})

const CoreManifestSchema = z.object({
  version: z.string().regex(SEMVER, 'must be a semver, e.g. 1.2.3'),
  declinedMigrations: z.array(DeclinedMigrationSchema).optional(),
})

/** @see DeclinedMigrationSchema */
export type DeclinedMigration = z.infer<typeof DeclinedMigrationSchema>

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
  const fromTags = latestCoreVersionFromTags(findRepoRoot(start) ?? start, defaultTagRunner, {
    fetch: false,
  })
  if (fromTags) return fromTags

  // Anything older that still carries the retired file.
  const path = findCoreVersionUpward(start)
  if (path) return readCoreVersionFile(path)

  throw new Error(
    `Could not determine the core version above ${start}: no package.json version and no ` +
      `core-v* tag.\n` +
      `Installed from npm, the package's own version answers this. In a template checkout the ` +
      `tags do — so a checkout with none (a shallow CI clone, or a source download with no git ` +
      `history) cannot say which core it is. Run \`git fetch --tags\` and retry, or use the ` +
      `published CLI (\`npx @biffo/cli\`), whose version is stamped at publish.`,
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
        if (
          typeof raw.version === 'string' &&
          SEMVER.test(raw.version) &&
          raw.version !== '0.0.0'
        ) {
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
  return parseInstanceCoreManifest(path).validated.version
}

/**
 * Read and validate `biffo.core.json`, returning both the validated view and the
 * raw object it was parsed from.
 *
 * The raw copy exists so a write can round-trip fields this CLI does not know
 * about — see `writeInstanceCoreVersion`. Zod strips unknown keys, so validated
 * data alone is a lossy basis for rewriting the file.
 */
function parseInstanceCoreManifest(path: string): {
  validated: z.infer<typeof CoreManifestSchema>
  raw: Record<string, unknown>
} {
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
  return {
    validated: result.data,
    raw: (parsed ?? {}) as Record<string, unknown>,
  }
}

/**
 * The core migrations this instance has declined to carry (#735).
 *
 * Empty when the instance records none, or is not an instance at all — an
 * absent list means "decline nothing", never an error, so this is safe to call
 * against any tree.
 */
export function readDeclinedMigrations(cwd: string): DeclinedMigration[] {
  const path = join(cwd, INSTANCE_CORE_FILE)
  if (!existsSync(path)) return []
  return parseInstanceCoreManifest(path).validated.declinedMigrations ?? []
}

/**
 * Whether an instance's orphaned `core.version` file can be safely removed by an
 * upgrade (#434).
 *
 * Since #423 the template ships no `core.version`, but instances scaffolded
 * before that inherited a copy through GitHub template generation. It is
 * user-owned (absent from both lists in `core-manifest.json`), so no upgrade
 * removes it, yet nothing reads it as an authority — `biffo.core.json` wins every
 * lookup. It survives only as a fallback in `deploy.ts` and `core-upgrade.ts`.
 *
 * An upgrade may delete it, but only when it is provably the un-repurposed
 * inherited value, because one known instance repurposed `core.version` as its
 * own app-release lineage — deleting that would destroy real data. The check is
 * therefore conservative and fails closed toward keeping the file:
 *
 *   - `biffo.core.json` (the authority) must be present and parseable. Without
 *     it there is nothing to compare against, so the file stays.
 *   - The `core.version` content must equal the version `biffo.core.json`
 *     records. At `biffo init` both files are written with the same version, so
 *     an untouched inherited copy still matches. A value that differs — an
 *     app-release string, or a non-semver — looks repurposed and is kept.
 *
 * The equal-to-authority test means an instance that has upgraded since init
 * (its `biffo.core.json` moved forward while `core.version` did not) keeps the
 * file rather than risk a wrong deletion — the safe direction. Returns null when
 * there is no `core.version` file to consider.
 */
export type CoreVersionKeepReason = 'repurposed' | 'no-authority'

export interface CoreVersionCleanup {
  /** Absolute path to the instance's `core.version` file. */
  path: string
  /** Remove it (inherited, un-repurposed) or keep it (repurposed / no authority). */
  action: 'delete' | 'keep'
  /** The `core.version` file's trimmed content, for reporting. */
  found: string
  /** Present only when action === 'keep'. */
  reason?: CoreVersionKeepReason
}

export function planCoreVersionCleanup(cwd: string): CoreVersionCleanup | null {
  const path = join(cwd, CORE_VERSION_FILE)
  if (!existsSync(path)) return null
  const found = readFileSync(path, 'utf8').trim()

  // `biffo.core.json` is the authority. Require it explicitly rather than via
  // readInstanceCoreVersion, which falls back to core.version when it is absent
  // — that fallback would compare the file against itself.
  if (!existsSync(join(cwd, INSTANCE_CORE_FILE))) {
    return { path, action: 'keep', found, reason: 'no-authority' }
  }
  let authority: string | null
  try {
    authority = readInstanceCoreVersion(cwd)
  } catch {
    // Malformed biffo.core.json — no trustworthy authority, so keep the file.
    return { path, action: 'keep', found, reason: 'no-authority' }
  }
  if (authority !== null && coreVersionsEqual(found, authority)) {
    return { path, action: 'delete', found }
  }
  return { path, action: 'keep', found, reason: 'repurposed' }
}

/** Semver-equal, tolerant of a non-semver `a` (a repurposed core.version can be
 * any string): an unparseable value simply is not equal to a core version. */
function coreVersionsEqual(a: string, b: string): boolean {
  try {
    return compareCoreVersions(a, b) === 0
  } catch {
    return false
  }
}

/**
 * Serialise a `biffo.core.json` body recording `version`, validating the semver
 * first. Shared by `writeInstanceCoreVersion` (local filesystem write, used by
 * `biffo core upgrade`) and `biffo init`, which commits the same bytes into the
 * freshly scaffolded repo over the GitHub API rather than to disk.
 */
export function serializeInstanceCoreVersion(
  version: string,
  rest: Record<string, unknown> = {},
): string {
  parseCoreVersion(version) // validate
  // `version` first so the file still reads the way it always has.
  return `${JSON.stringify({ version, ...rest }, null, 2)}\n`
}

/**
 * Write `<cwd>/biffo.core.json` recording `version` — used by an upgrade to bump
 * the instance's recorded core version in the same commit.
 *
 * **Every other field in the file is preserved.** This used to serialise
 * `{ version }` and nothing else, which was harmless while that was the only
 * field and silently destructive the moment it wasn't: `declinedMigrations`
 * (#735) is read *during* an upgrade and the file rewritten *by* the same
 * upgrade, so a wholesale overwrite would erase the declines it had just
 * honoured. The instance would then re-propose them on the next run — the exact
 * bug #735 exists to fix, reintroduced one layer down and much harder to see.
 *
 * Preserving unknown keys rather than an enumerated list is deliberate: a field
 * added later is protected without anyone having to remember this function.
 */
export function writeInstanceCoreVersion(cwd: string, version: string): void {
  const path = join(cwd, INSTANCE_CORE_FILE)
  let rest: Record<string, unknown> = {}
  if (existsSync(path)) {
    rest = { ...parseInstanceCoreManifest(path).raw }
    delete rest.version // re-supplied by serializeInstanceCoreVersion, and first
  }
  writeFileSync(path, serializeInstanceCoreVersion(version, rest))
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
export interface TagLookupOptions {
  /**
   * Fetch tags from the remote first. Default true.
   *
   * On for anything asking "what is the newest release?" — a stale local tag
   * set silently resolved the wrong upgrade target in #428, and tags do not
   * arrive with `git pull`. Off for anything asking "what version am I?", which
   * is answered by what is already in hand: a lookup has no business making a
   * network round-trip, least of all inside `biffo init` or a unit test.
   */
  fetch?: boolean
}

export function latestCoreVersionFromTags(
  repo: string,
  git: TagRunner = defaultTagRunner,
  options: TagLookupOptions = {},
): string | null {
  if (options.fetch !== false) {
    try {
      git(['-C', repo, 'fetch', '--tags', '--quiet'])
    } catch {
      /* offline, or no remote — fall through to whatever is local */
    }
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
