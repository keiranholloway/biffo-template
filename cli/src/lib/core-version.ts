import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, parse as parsePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/**
 * Core versioning primitives for ADR-0006 (Core Upgrade and Template Sync).
 *
 * Two files carry the version:
 *   - `core.version` at the template repo root — the single source of truth for
 *     the template's current core version. Every scaffolded instance inherits a
 *     copy via GitHub template generation.
 *   - `biffo.core.json` at an instance repo root — records the core version that
 *     instance was initialised from (and, later, last upgraded to).
 *
 * `biffo core status` compares the instance's recorded version (from cwd's
 * `biffo.core.json`) against the version this CLI ships with (its bundled
 * `core.version`).
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

const CoreManifestSchema = z.object({
  version: z.string().regex(SEMVER, 'must be a semver, e.g. 1.2.3'),
})

export const CORE_VERSION_FILE = 'core.version'
export const INSTANCE_CORE_FILE = 'biffo.core.json'

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
  const path = findCoreVersionUpward(start)
  if (!path) {
    throw new Error(
      `Could not locate a ${CORE_VERSION_FILE} file above ${start}. This CLI build is missing its core version.`,
    )
  }
  return readCoreVersionFile(path)
}

/**
 * The core version an instance repo is currently on.
 *
 * `core.version` is the single committed source of truth for a core version —
 * the template ships it and every instance inherits a copy via template
 * generation. `biffo.core.json` is NOT a committed seed; it is written only when
 * `biffo core upgrade` records an upgrade (so the *next* upgrade knows the
 * from-version independently of the synced `core.version` file).
 *
 * Resolution therefore prefers the explicit upgrade record and falls back to the
 * inherited `core.version`:
 *   1. `<cwd>/biffo.core.json` if present (an instance that has been upgraded);
 *   2. otherwise `<cwd>/core.version` (a freshly-scaffolded instance);
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
