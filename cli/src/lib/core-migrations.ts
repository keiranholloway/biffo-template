import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DeclinedMigration } from './core-version.js'

/**
 * Append-only carry of the template's *core* Alembic migrations into an
 * instance, for `biffo core upgrade` (issue #198).
 *
 * ## Why this exists as a separate mechanism
 *
 * `services/api/` is template-owned, but `services/api/migrations/versions/` is
 * deliberately **user-owned** (see `core-manifest.json`): an instance's
 * migrations are an append-only chain that accumulates the instance's own and
 * its plugins' migrations, chained by `down_revision`. Three-way-merging that
 * directory would rewrite an instance's revision graph — so the merge engine
 * must keep its hands off it, and does.
 *
 * The consequence was the bug in #198: a core feature that adds tables reached
 * an instance as models + routers with **no migration**, and shipped dead on
 * arrival. The orchestration migration (`0003_…`) was never carried, and could
 * not have been carried verbatim anyway — its revision id `0003` collided with a
 * different `0003` already in the instance, whose head was `0006`.
 *
 * ## What this does instead
 *
 * A narrow, **additive** carry that runs alongside (not through) the merge
 * engine:
 *
 * - Only files **absent** from the instance are added. A migration already
 *   present is never modified, re-chained, re-numbered, or deleted — an applied
 *   migration is immutable history.
 * - Each carried file is re-chained: its `down_revision` is rewritten to the
 *   instance's actual head at that point, so carried migrations *append* to the
 *   instance's chain instead of forking a second head.
 * - Its `revision` id is preserved verbatim unless it collides with an id the
 *   instance already uses, in which case it is deterministically re-issued as
 *   `core_<sha256(filename)[:8]>`. A collision means the instance has never
 *   applied the template's copy of that migration, so re-issuing is safe.
 * - The resulting chain is validated (every parent resolves, exactly one head,
 *   no cycles) **before** anything is written. Any anomaly aborts the upgrade.
 *
 * ## Why at upgrade time and not deploy time
 *
 * ADR-0003's Implementation Note records the production incident this design is
 * built to avoid: migrations were once generated at Lambda `db-init` time into
 * an ephemeral directory, so a migration silently regenerated with a different
 * `down_revision` on the next deploy and corrupted the graph while `db-init`
 * reported success (`ddl_import_history` appeared to migrate but never
 * existed). The re-chaining here happens **once, at CLI upgrade time**, and its
 * output is a real file committed to the upgrade PR and reviewed by a human.
 * Nothing is ever generated or re-chained at deploy time; `db-init` only ever
 * applies what is committed. Re-running an upgrade is idempotent — a carried
 * file is identified by filename and skipped, never re-chained a second time.
 */

/** A parsed Alembic version file. */
export interface MigrationFile {
  /** Basename, e.g. `0003_create_orchestration_tables.py`. */
  file: string
  revision: string
  downRevision: string | null
  content: string
}

/** A migration the upgrade should add to the instance, already re-chained. */
export interface MigrationCarryEntry {
  /** Repo-relative posix path to write in the instance. */
  path: string
  file: string
  revision: string
  downRevision: string | null
  /** The template's revision id, when it had to be re-issued to avoid a clash. */
  reissuedFrom?: string
  content: string
}

export interface MigrationCarryPlan {
  entries: MigrationCarryEntry[]
  /** The instance's head before the carry (null when it has no migrations). */
  instanceHead: string | null
  /** Template migrations the instance already has — left untouched. */
  skipped: string[]
  /**
   * Of those, the ones recognised by something other than their filename. The
   * upgrade surfaces these: they are the cases filename matching alone used to
   * get wrong, and seeing "recognised by body hash" is how an operator learns
   * their instance has a renamed carry (#366).
   */
  recognised: RecognisedCarry[]
  /**
   * Template migrations skipped because `biffo.core.json` declines them (#735).
   * Reported rather than merely omitted: a decline that applies invisibly is
   * indistinguishable from a tool that forgot the migration existed.
   */
  declined: DeclinedCarry[]
  /**
   * Declared declines that match no migration in the target template — a typo,
   * or a decline whose cause has been fixed upstream and which should now be
   * deleted from `biffo.core.json`.
   */
  staleDeclines: string[]
}

/** A declined migration, as reported back in the plan. */
export interface DeclinedCarry {
  /** The template filename that was skipped. */
  file: string
  reason: string
  upstream?: string
}

export const MIGRATIONS_VERSIONS_DIR = 'services/api/migrations/versions'

const REVISION_RE = /^(revision\b[^=\n]*=\s*)(.+)$/m
const DOWN_REVISION_RE = /^(down_revision\b[^=\n]*=\s*)(.+)$/m

function parseLiteral(raw: string): string | null {
  const value = raw.trim()
  if (value === 'None' || value === 'null') return null
  const quoted = /^(['"])(.*)\1$/.exec(value)
  if (!quoted) {
    throw new Error(`Unsupported revision literal: ${value}`)
  }
  return quoted[2] ?? null
}

function renderLiteral(value: string | null): string {
  return value === null ? 'None' : `"${value}"`
}

/** Parse the `revision` / `down_revision` module-level literals out of an
 * Alembic version file. Throws if either is missing or not a plain literal —
 * a computed revision id is not something this carry can safely re-chain. */
export function parseMigration(file: string, content: string): MigrationFile {
  const rev = REVISION_RE.exec(content)
  const down = DOWN_REVISION_RE.exec(content)
  if (!rev?.[2]) {
    throw new Error(`${file}: could not find a module-level 'revision = ...' assignment.`)
  }
  if (!down?.[2]) {
    throw new Error(`${file}: could not find a module-level 'down_revision = ...' assignment.`)
  }
  let revision: string | null
  let downRevision: string | null
  try {
    revision = parseLiteral(rev[2])
    downRevision = parseLiteral(down[2])
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`)
  }
  if (revision === null) {
    throw new Error(`${file}: 'revision' must be a string literal, got None.`)
  }
  return { file, revision, downRevision, content }
}

/** Read and parse every `*.py` version file in an Alembic versions directory.
 * A missing directory reads as an empty chain. */
export function readMigrations(versionsDir: string): MigrationFile[] {
  if (!existsSync(versionsDir)) return []
  return readdirSync(versionsDir)
    .filter((f) => f.endsWith('.py') && f !== '__init__.py')
    .sort()
    .map((f) => parseMigration(f, readFileSync(join(versionsDir, f), 'utf8')))
}

/** Rewrite a migration file's `revision` / `down_revision` (and the matching
 * docstring header lines, so the file reads honestly) without touching its DDL. */
export function rechainMigration(
  content: string,
  revision: string,
  downRevision: string | null,
): string {
  let out = content.replace(REVISION_RE, (_m, lhs: string) => `${lhs}${renderLiteral(revision)}`)
  out = out.replace(DOWN_REVISION_RE, (_m, lhs: string) => `${lhs}${renderLiteral(downRevision)}`)
  out = out.replace(/^Revision ID: .*$/m, `Revision ID: ${revision}`)
  out = out.replace(/^Revises: .*$/m, `Revises: ${downRevision ?? ''}`)
  return out
}

/**
 * Validate a set of migrations as a single linear-enough Alembic chain: every
 * `down_revision` resolves to a known revision, no duplicate ids, no cycles,
 * and exactly one head. Returns the head (null for an empty chain).
 *
 * This is the loud failure the ADR-0003 incident lacked — a broken graph aborts
 * the upgrade before a PR exists, rather than deploying and reporting success.
 */
export function validateChain(migrations: MigrationFile[], label: string): string | null {
  if (migrations.length === 0) return null

  const byRevision = new Map<string, MigrationFile>()
  for (const m of migrations) {
    const existing = byRevision.get(m.revision)
    if (existing) {
      throw new Error(
        `${label}: duplicate revision id "${m.revision}" in ${existing.file} and ${m.file}.`,
      )
    }
    byRevision.set(m.revision, m)
  }

  const children = new Map<string, string[]>()
  const roots: MigrationFile[] = []
  for (const m of migrations) {
    if (m.downRevision === null) {
      roots.push(m)
      continue
    }
    if (!byRevision.has(m.downRevision)) {
      throw new Error(
        `${label}: ${m.file} chains onto down_revision "${m.downRevision}", which no migration defines.`,
      )
    }
    children.set(m.downRevision, [...(children.get(m.downRevision) ?? []), m.revision])
  }

  if (roots.length === 0) {
    throw new Error(`${label}: no base migration (every revision has a parent) — the chain cycles.`)
  }
  if (roots.length > 1) {
    throw new Error(
      `${label}: ${roots.length} base migrations (${roots.map((r) => r.file).join(', ')}) — expected one.`,
    )
  }

  const heads = [...byRevision.values()].filter(
    (m) => (children.get(m.revision) ?? []).length === 0,
  )
  if (heads.length !== 1) {
    throw new Error(
      `${label}: ${heads.length} heads (${heads.map((h) => h.file).join(', ')}) — Alembic needs exactly one. ` +
        'Resolve the branch manually before upgrading.',
    )
  }

  // Reachability from the single root proves there's no detached cycle.
  let reachable = 0
  const queue = [roots[0]?.revision as string]
  const seen = new Set<string>(queue)
  while (queue.length > 0) {
    const rev = queue.shift() as string
    reachable++
    for (const child of children.get(rev) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  if (reachable !== migrations.length) {
    throw new Error(
      `${label}: ${migrations.length - reachable} migration(s) are unreachable from the base — the chain contains a cycle.`,
    )
  }

  return heads[0]?.revision ?? null
}

/** Template chain order: base first, each following its parent. Falls back to
 * filename order for any migration whose parent isn't in the same tree. */
function chainOrder(migrations: MigrationFile[]): MigrationFile[] {
  const byRevision = new Map(migrations.map((m) => [m.revision, m]))
  const children = new Map<string, MigrationFile[]>()
  const roots: MigrationFile[] = []
  for (const m of migrations) {
    if (m.downRevision !== null && byRevision.has(m.downRevision)) {
      children.set(m.downRevision, [...(children.get(m.downRevision) ?? []), m])
    } else {
      roots.push(m)
    }
  }
  const ordered: MigrationFile[] = []
  const seen = new Set<string>()
  const visit = (m: MigrationFile): void => {
    if (seen.has(m.revision)) return
    seen.add(m.revision)
    ordered.push(m)
    for (const c of children.get(m.revision) ?? []) visit(c)
  }
  for (const r of roots) visit(r)
  for (const m of migrations) visit(m) // anything left (shouldn't happen)
  return ordered
}

/** Deterministic replacement revision id for a template migration whose own id
 * is already taken in the instance. Keyed on the filename, so re-running an
 * upgrade that was interrupted produces the same id. */
export function reissuedRevisionId(file: string): string {
  return `core_${createHash('sha256').update(file).digest('hex').slice(0, 8)}`
}

/**
 * Provenance marker stamped into every carried migration, naming the template
 * file it came from (issue #366).
 *
 * Filename, not revision id: the revision is frequently re-issued on carry
 * (`core_<hash>`) and can be renumbered again by the instance, whereas the
 * template filename is the stable identity of "which core migration is this".
 */
export const CARRIED_FROM_MARKER = '# biffo:carried-from:'
const CARRIED_FROM_RE = /^# biffo:carried-from:[ \t]*(\S+)[ \t]*$/m

/** The template migration a carried file records itself as coming from, or null
 * for a migration the instance wrote (or one carried before #366 shipped). */
export function parseCarriedFrom(content: string): string | null {
  return CARRIED_FROM_RE.exec(content)?.[1] ?? null
}

/** Stamp the provenance marker above the `revision` assignment. Idempotent: a
 * file that already carries a marker is returned unchanged, so re-running an
 * interrupted upgrade cannot accumulate duplicates. */
export function stampCarriedFrom(content: string, templateFile: string): string {
  if (CARRIED_FROM_RE.test(content)) return content
  return content.replace(REVISION_RE, (m) => `${CARRIED_FROM_MARKER} ${templateFile}\n${m}`)
}

/** The module docstring, if the file opens with one. */
const MODULE_DOCSTRING_RE = /^\s*("""|''')[\s\S]*?\1/

/**
 * Identity of a migration's *substance*: its DDL, and nothing else.
 *
 * Stripped, because none of it is schema —
 *
 *   - the `revision` / `down_revision` assignments, which a carry rewrites by
 *     design;
 *   - the module docstring, and any full-line `#` comment;
 *   - the provenance marker;
 *   - blank lines and trailing whitespace.
 *
 * **Commentary is not substance.** An instance that has to renumber a carried
 * migration typically documents why, in the docstring — which is the careful
 * thing to do, and used to defeat this comparison. Every carried migration in
 * `tabsii-platform` is DDL-identical to the template's and differs only in
 * prose explaining the workaround; treating that as a different migration meant
 * the operators who documented their divergence were the ones penalised for it.
 *
 * Ignoring prose is not a loosening. Two migrations with the same DDL *are* the
 * same migration for carry purposes, and the discriminating-body rule in
 * `alreadyCarried` still refuses to draw any conclusion from a body that more
 * than one migration shares.
 *
 * Inline trailing comments are deliberately NOT stripped: doing so means
 * distinguishing a `#` that starts a comment from one inside a string literal,
 * which needs a Python parser. Whole-line comments cover the real case.
 */
export function migrationBodyHash(content: string): string {
  const normalised = content
    .replace(MODULE_DOCSTRING_RE, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        !REVISION_RE.test(line) &&
        !DOWN_REVISION_RE.test(line) &&
        !line.trimStart().startsWith('#') &&
        line !== '',
    )
    .join('\n')
  return createHash('sha256').update(normalised).digest('hex')
}

/**
 * The descriptive part of a version filename, with any leading revision-ish
 * prefix removed: `0007_create_orchestration_tables.py` and
 * `0003_create_orchestration_tables.py` share the slug
 * `create_orchestration_tables`.
 *
 * This is the tell for the #366 trap specifically. An instance forced to
 * renumber a carried migration renames the file to match its new revision id
 * and leaves the description alone, so the slug survives the rename that
 * defeats filename matching.
 */
export function migrationSlug(file: string): string {
  return file.replace(/\.py$/, '').replace(/^[0-9a-f]+_/i, '')
}

export interface PlanMigrationCarryOptions {
  /** Template checkout at the target version. */
  templateDir: string
  /** The instance repo root. */
  instanceDir: string
  /**
   * Migrations this instance has declined to carry, from `biffo.core.json`
   * (#735). Matched on the *template's* filename, which is the stable identity —
   * the instance has no copy to match by provenance, that being the point.
   */
  declined?: DeclinedMigration[]
}

/**
 * Plan the additive carry of template core migrations into an instance.
 * Pure: reads both trees, writes nothing.
 */
export function planMigrationCarry(options: PlanMigrationCarryOptions): MigrationCarryPlan {
  const templateVersions = join(options.templateDir, MIGRATIONS_VERSIONS_DIR)
  const instanceVersions = join(options.instanceDir, MIGRATIONS_VERSIONS_DIR)

  const template = readMigrations(templateVersions)
  const instance = readMigrations(instanceVersions)

  // Refuse to touch an already-broken instance chain: re-chaining onto an
  // ambiguous head is exactly how a revision graph gets silently corrupted.
  const instanceHead = validateChain(instance, `${MIGRATIONS_VERSIONS_DIR} (instance)`)

  const usedRevisions = new Set(instance.map((m) => m.revision))
  const identity = indexInstanceMigrations(instance)
  const templateBodyCounts = new Map<string, number>()
  for (const m of template) {
    const body = migrationBodyHash(m.content)
    templateBodyCounts.set(body, (templateBodyCounts.get(body) ?? 0) + 1)
  }

  const entries: MigrationCarryEntry[] = []
  const skipped: string[] = []
  const recognised: RecognisedCarry[] = []
  const declinedIndex = new Map((options.declined ?? []).map((d) => [d.file, d]))
  const declined: DeclinedCarry[] = []
  let head = instanceHead

  for (const m of chainOrder(template)) {
    const decline = declinedIndex.get(m.file)
    if (decline) {
      // Skipped without advancing `head`, so the chain closes over the gap and
      // the next carried migration points at whatever the instance's real head
      // is — never at a revision the instance does not have.
      declined.push({
        file: m.file,
        reason: decline.reason,
        ...(decline.upstream !== undefined && { upstream: decline.upstream }),
      })
      continue
    }

    const already = alreadyCarried(m, identity, templateBodyCounts)
    if (already) {
      // Already in the instance — immutable history, never re-chained.
      skipped.push(m.file)
      if (already.how !== 'filename') {
        recognised.push({ file: m.file, instanceFile: already.instance.file, how: already.how })
      }
      continue
    }

    let revision = m.revision
    let reissuedFrom: string | undefined
    if (usedRevisions.has(revision)) {
      const replacement = reissuedRevisionId(m.file)
      if (usedRevisions.has(replacement)) {
        throw new Error(
          `Cannot carry ${m.file}: its revision id "${revision}" is already used in the instance, ` +
            `and so is the deterministic replacement "${replacement}". Resolve manually.`,
        )
      }
      reissuedFrom = revision
      revision = replacement
    }

    const entry: MigrationCarryEntry = {
      path: `${MIGRATIONS_VERSIONS_DIR}/${m.file}`,
      file: m.file,
      revision,
      downRevision: head,
      // Stamped before re-chaining so the instance's copy records which template
      // migration it is, whatever it is later renamed or renumbered to.
      content: rechainMigration(stampCarriedFrom(m.content, m.file), revision, head),
    }
    if (reissuedFrom !== undefined) entry.reissuedFrom = reissuedFrom
    entries.push(entry)

    usedRevisions.add(revision)
    head = revision
  }

  // Prove the post-carry chain is still a single valid line before any of it is
  // offered to the caller to write.
  validateChain(
    [
      ...instance,
      ...entries.map((e) => ({
        file: e.file,
        revision: e.revision,
        downRevision: e.downRevision,
        content: e.content,
      })),
    ],
    `${MIGRATIONS_VERSIONS_DIR} (after carry)`,
  )

  // A decline naming a migration the target template no longer ships matched
  // nothing. That is either a typo — silently declining nothing, which is the
  // worst outcome here — or a decline that has outlived its cause, as #670 did
  // by fixing the migration tabsii declined. Both want surfacing, neither is
  // fatal.
  const templateFiles = new Set(template.map((m) => m.file))
  const staleDeclines = [...declinedIndex.keys()].filter((f) => !templateFiles.has(f))

  return { entries, instanceHead, skipped, recognised, declined, staleDeclines }
}

/** How a template migration was recognised as already present in the instance. */
export type CarryMatchKind = 'provenance' | 'filename' | 'body'

/** A template migration recognised as already carried by something other than
 * its filename — worth surfacing, because it is the case filename matching
 * alone used to get wrong (#366). */
export interface RecognisedCarry {
  /** Template filename. */
  file: string
  /** What the instance calls its copy. */
  instanceFile: string
  how: CarryMatchKind
}

interface InstanceIndex {
  byCarriedFrom: Map<string, MigrationFile>
  byFile: Map<string, MigrationFile>
  byBody: Map<string, MigrationFile[]>
  bySlug: Map<string, MigrationFile[]>
}

function indexInstanceMigrations(instance: MigrationFile[]): InstanceIndex {
  const index: InstanceIndex = {
    byCarriedFrom: new Map(),
    byFile: new Map(),
    byBody: new Map(),
    bySlug: new Map(),
  }
  for (const m of instance) {
    index.byFile.set(m.file, m)
    const from = parseCarriedFrom(m.content)
    if (from !== null) index.byCarriedFrom.set(from, m)
    const body = migrationBodyHash(m.content)
    index.byBody.set(body, [...(index.byBody.get(body) ?? []), m])
    const slug = migrationSlug(m.file)
    index.bySlug.set(slug, [...(index.bySlug.get(slug) ?? []), m])
  }
  return index
}

/**
 * Decide whether the instance already has this template migration.
 *
 * ## The bug this replaces (#366)
 *
 * Identity used to be the filename alone, which is defeated by exactly the
 * thing instances are pushed into doing. A template migration arrives as
 * `0003_create_orchestration_tables.py`; if the instance already used revision
 * `0003`, the carry re-issues the id and the instance renames the file to match
 * — `0007_create_orchestration_tables.py`. Same content, applied, done. But the
 * filename no longer matches, so the *next* upgrade does not skip it: it
 * re-issues the migration onto the current head, and `op.create_table(...)` runs
 * against a database that already has those tables. Because `db-init` runs
 * `command.upgrade(cfg, "head")` on every deploy, that lands as a **failed
 * production deploy**, not a caught mistake.
 *
 * ## Evidence, strongest first
 *
 * 1. **Provenance** — the carried file names the template migration it came
 *    from. Exact, and survives any rename or renumber. Only present on
 *    migrations carried since #366.
 * 2. **Filename** — the original signal, and still the common case.
 * 3. **Body** — same DDL once the re-chainable parts are stripped. This is what
 *    recognises migrations carried *before* provenance existed and since
 *    renamed, which is the whole population currently in the trap.
 *
 * ## Where it stops rather than guesses
 *
 * A slug match with a differing body is the residual ambiguity: it looks like a
 * carried migration that was renamed *and* edited, but it could equally be an
 * unrelated instance migration that happens to describe the same thing. Guessing
 * either way is unsafe — skip and the instance silently never gets the schema;
 * carry and DDL runs against a live database. So it stops, names both files, and
 * says how to resolve it. A hard stop is far better than DDL against a live
 * database.
 */
function alreadyCarried(
  m: MigrationFile,
  index: InstanceIndex,
  templateBodyCounts: Map<string, number>,
): { instance: MigrationFile; how: CarryMatchKind } | null {
  const byProvenance = index.byCarriedFrom.get(m.file)
  if (byProvenance) return { instance: byProvenance, how: 'provenance' }

  const byFile = index.byFile.get(m.file)
  if (byFile) return { instance: byFile, how: 'filename' }

  // Body identity is evidence only when the body actually DISCRIMINATES. Two
  // migrations can share one — `pass`, or a pair of no-op placeholders — and
  // treating that as "already carried" would silently skip a migration the
  // instance needs, leaving it with models and no schema. So it counts only
  // when exactly one migration on each side has this body.
  const body = migrationBodyHash(m.content)
  const bodyMatches = index.byBody.get(body) ?? []
  if (bodyMatches.length === 1 && templateBodyCounts.get(body) === 1) {
    return { instance: bodyMatches[0] as MigrationFile, how: 'body' }
  }

  const slugMatches = (index.bySlug.get(migrationSlug(m.file)) ?? []).filter(
    // A file already claimed as a copy of some OTHER template migration is not
    // an ambiguous match for this one.
    (candidate) => parseCarriedFrom(candidate.content) === null,
  )
  if (slugMatches.length > 0) {
    const names = slugMatches.map((c) => c.file).join(', ')
    throw new Error(
      `Cannot carry ${m.file}: the instance has ${names}, which describes the same migration ` +
        `but whose contents differ, and which carries no provenance marker. Refusing to guess.\n\n` +
        `  If it IS this migration (carried before provenance was recorded, then renamed or ` +
        `edited), add this line above its 'revision' assignment and re-run:\n\n` +
        `      ${CARRIED_FROM_MARKER} ${m.file}\n\n` +
        `  If it is unrelated, rename it so the descriptions differ.\n\n` +
        `  Carrying it blindly would re-issue an already-applied migration and run its DDL ` +
        `against a database that already has those objects (#366).`,
    )
  }

  return null
}

/**
 * Write a carry plan into the instance working tree. Only ever creates new
 * files — a path that already exists is a bug in the planner (it should have
 * been skipped), so this refuses to overwrite one rather than clobber applied
 * history.
 */
export function applyMigrationCarry(instanceDir: string, plan: MigrationCarryPlan): string[] {
  const written: string[] = []
  for (const e of plan.entries) {
    const abs = join(instanceDir, e.path)
    if (existsSync(abs)) {
      throw new Error(`Refusing to overwrite an existing migration: ${e.path}`)
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, e.content)
    written.push(e.path)
  }
  return written
}
