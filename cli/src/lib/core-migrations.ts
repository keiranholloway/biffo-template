import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
  /** Instance migrations already carrying a template filename — left untouched. */
  skipped: string[]
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

export interface PlanMigrationCarryOptions {
  /** Template checkout at the target version. */
  templateDir: string
  /** The instance repo root. */
  instanceDir: string
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

  const instanceFiles = new Set(instance.map((m) => m.file))
  const usedRevisions = new Set(instance.map((m) => m.revision))

  const entries: MigrationCarryEntry[] = []
  const skipped: string[] = []
  let head = instanceHead

  for (const m of chainOrder(template)) {
    if (instanceFiles.has(m.file)) {
      // Already in the instance — immutable history, never re-chained.
      skipped.push(m.file)
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
      content: rechainMigration(m.content, revision, head),
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

  return { entries, instanceHead, skipped }
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
