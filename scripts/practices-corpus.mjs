/**
 * Shared read/write helpers for the practices evidence corpus (#1132).
 *
 * ## Why a directory, not one shared file
 *
 * `docs/practices/evidence.jsonl` was a single file every concurrent session
 * appended to. N writers, one path — conflicts **by construction**, the same
 * class already fixed twice in this repo (`core.version` #423, the generated
 * tally block #953). The lever is the same: stop sharing the path. New rows go
 * into their own file under `docs/practices/evidence/`, one per entry, e.g.
 *
 *     docs/practices/evidence/2026-08-03-metric-denominator-blindness.json
 *
 * Two sessions writing on the same day still never collide — their filenames
 * differ.
 *
 * ## Migration: read both, split nothing
 *
 * Splitting the ~430 existing rows into ~430 files was rejected: it is more
 * expensive than the alternative for no benefit, and it would re-serialise a
 * file that must never be re-serialised (whole-file rewrites are the exact
 * defect being fixed). Instead `evidence.jsonl` is now a **frozen legacy
 * file** — nothing ever appends to it again — and the read side merges it
 * with the directory. See `practices-monotonic.mjs` for the guard that keeps
 * it frozen rather than shrunk.
 *
 * ## Ordering
 *
 * Filenames carry the date (`YYYY-MM-DD-slug.json`), so the read side sorts
 * the directory listing by filename rather than relying on directory order,
 * which the filesystem does not guarantee. Legacy rows keep their existing
 * file order (untouched) and sort BEFORE every directory row — they predate
 * all of them by construction.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LEGACY_EVIDENCE = 'docs/practices/evidence.jsonl'
export const EVIDENCE_DIR = 'docs/practices/evidence'

/** The per-entry directory that goes with a legacy `.jsonl` path. */
export function corpusDirFor(legacyFile) {
  return legacyFile.replace(/\.jsonl$/, '')
}

/**
 * Parse the legacy newline-delimited JSON file, leniently: one malformed line
 * is dropped rather than failing the whole read. Matches the tolerance this
 * file's readers already had before #1132 (a scan for ranking, not a strict
 * audit — `readCorpusStrict` below is the strict counterpart).
 */
export function readLegacyEvidence(file = LEGACY_EVIDENCE) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** `*.json` filenames directly under the evidence directory, sorted so date-prefixed names order chronologically. */
export function listEvidenceFiles(dir = EVIDENCE_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
}

/** Every per-entry file, parsed, alongside the filename it came from — needed to rewrite a specific entry (e.g. `--enrich`). */
export function readEvidenceDirEntries(dir = EVIDENCE_DIR) {
  return listEvidenceFiles(dir)
    .map((file) => {
      try {
        return { file, row: JSON.parse(readFileSync(join(dir, file), 'utf8')) }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** Every per-entry file's row, sorted by filename. Malformed files are dropped, not fatal. */
export function readEvidenceDir(dir = EVIDENCE_DIR) {
  return readEvidenceDirEntries(dir).map((e) => e.row)
}

/**
 * The full corpus, lenient: legacy rows (their existing order, untouched)
 * followed by directory rows (sorted by filename). A concatenation, not a
 * merge — the two never name the same entry, so there is nothing to
 * reconcile.
 *
 * @param {string} legacyFile path to the legacy `.jsonl`; its sibling
 *   directory is derived from it (`corpusDirFor`)
 */
export function readCorpus(legacyFile = LEGACY_EVIDENCE) {
  return [...readLegacyEvidence(legacyFile), ...readEvidenceDir(corpusDirFor(legacyFile))]
}

/**
 * The full corpus, strict: throws on the first line or file that fails to
 * parse, and throws if neither the legacy file nor the directory has
 * anything to read. For callers whose whole point is "never report a zero
 * that could actually be 'could not read this'" (`summariseFailOpenBacklog`)
 * — a corpus that half-parses must not silently look like a smaller valid
 * one.
 *
 * @param {string} legacyFile
 */
export function readCorpusStrict(legacyFile = LEGACY_EVIDENCE) {
  const dir = corpusDirFor(legacyFile)
  const legacyExists = existsSync(legacyFile)
  const dirFiles = listEvidenceFiles(dir)
  if (!legacyExists && dirFiles.length === 0) {
    throw new Error(`no corpus at ${legacyFile} or ${dir}`)
  }
  const legacyRows = legacyExists
    ? readFileSync(legacyFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l))
    : []
  const dirRows = dirFiles.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  return [...legacyRows, ...dirRows]
}

/** Filename-safe token from a row's summary. */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Write ONE new evidence entry as its own file. This is the write path every
 * future session uses — never append to `evidence.jsonl`, which is frozen.
 *
 * Refuses to overwrite an existing file: a collision means the slug needs to
 * be more specific, not that the earlier entry should be silently replaced.
 *
 * The refusal is an atomic `wx` create, not an `existsSync` check followed by
 * a write (#1222). This corpus has concurrent writers BY DESIGN — several
 * agent sessions run against this estate at once — so the window between a
 * check and a write is not theoretical here: two sessions writing the same
 * `date-slug` is the exact case the guard exists for, and the check-then-write
 * form lost the earlier entry rather than refusing. `EEXIST` is translated
 * back into the same message, so nothing else changes.
 *
 * @param {Record<string, any>} row
 * @param {{dir?: string, date?: string, slug?: string}} [opts]
 * @returns {string} the path written, relative to `opts.dir`'s base
 */
export function writeEvidenceEntry(row, opts = {}) {
  const dir = opts.dir ?? EVIDENCE_DIR
  // `undefined` means "nobody said"; `null` means "known to be unknown". Both
  // must reach the stored field as null rather than today's date.
  //
  // This used to read `opts.date ?? row.date ?? new Date()…` and write that
  // single value to BOTH the filename and the row. The module docstring says
  // the opposite in as many words — "Rows citing nothing keep `date: null` —
  // never a guess, because a fabricated date would corrupt exactly the ranking
  // this exists to enable" — and `--extract` even passes `date: row.date ??
  // null` to say so explicitly. `null ?? today` discarded that.
  //
  // It was invisible while rows were extracted the day they were written, and
  // surfaced on 2026-08-09 when extracting five rows also swept up eighteen
  // older ones and stamped every one with that day. `--enrich` recovers real
  // dates from the cited issues afterwards, and it can only do that for rows
  // whose date is *absent*; a fabricated one looks recovered and is skipped.
  const date = opts.date ?? row.date ?? null
  const slug = opts.slug ?? slugify(row.summary) ?? 'entry'
  mkdirSync(dir, { recursive: true })
  // The filename is used only for sorting and uniqueness — every reader parses
  // the JSON body — so an undated row says so here too, rather than carrying a
  // date prefix that the data it contains denies.
  const file = `${date ?? 'undated'}-${slug || 'entry'}.json`
  const path = join(dir, file)
  try {
    writeFileSync(path, `${JSON.stringify({ ...row, date }, null, 2)}\n`, { flag: 'wx' })
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new Error(`${path} already exists — choose a more specific slug or date`)
    }
    throw err
  }
  return path
}

/** Overwrite one already-existing per-entry file in place (e.g. `--enrich` filling in a date). Never touches the legacy file. */
export function writeEvidenceFile(dir, file, row) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), `${JSON.stringify(row, null, 2)}\n`)
}
