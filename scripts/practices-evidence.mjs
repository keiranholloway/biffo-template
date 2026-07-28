/**
 * Turn the practices scoreboard from prose into a dataset, and keep it that way.
 *
 * ## Why
 *
 * `docs/guides/development-practices.md` holds 41 rows of real, expensive
 * failures and **cannot rank any of them**: exactly one row carries a cost
 * figure and none carries a date. "Highest impact first" is therefore an
 * opinion, which is the one thing the page says it must never be.
 *
 * Worse, its headline conclusion — "fail-open is the dominant shape — three of
 * the five filed issues" — was written against a 5-row sample and never revised
 * as the sample grew eightfold. Counted by primary class across all 41 rows:
 * visibility 13, drift 12, boundary 7, fail-open 6, process 3 — fail-open is
 * fourth. A narrative appended to by hand drifts from the rows above it,
 * silently, and reads exactly as confidently while doing so.
 *
 * So: rows become records, and the narrative is **generated** from the records.
 * A conclusion can then be wrong, but it cannot disagree with its own evidence.
 *
 * ## Dates are recovered, not invented
 *
 * Almost every row cites an issue or PR. `--enrich` resolves the earliest
 * referenced item's creation date and uses it as when the failure surfaced.
 * Rows citing nothing keep `date: null` — never a guess, because a fabricated
 * date would corrupt exactly the ranking this exists to enable.
 *
 * Usage:
 *   node scripts/practices-evidence.mjs --extract   # markdown -> evidence.jsonl
 *   node scripts/practices-evidence.mjs --enrich    # add dates from GitHub
 *   node scripts/practices-evidence.mjs --report    # regenerate the analysis
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const SOURCE = 'docs/guides/development-practices.md'
export const EVIDENCE = 'docs/practices/evidence.jsonl'

/** The five failure shapes. Order is the page's own. */
export const CLASSES = ['fail-open', 'boundary', 'drift', 'visibility', 'process']

/** Repo a bare `#N` reference belongs to. */
export const DEFAULT_REPO = 'keiranholloway/biffo-template'

/** Prefixes used in the table for other repos. */
export const REPO_PREFIXES = {
  tabsii: 'tabsii-com/tabsii-platform',
  'biffo-runners': 'keiranholloway/biffo-runners',
  'idea-scout': 'keiranholloway/biffo-plugin-idea-scout',
}

/**
 * Every GitHub reference in a table row, in the order they appear.
 *
 * Both bare (`#690`) and prefixed (`tabsii#252`) forms occur, and a row's
 * *earliest* reference is the best available proxy for when the failure
 * surfaced — later ones are usually the fix.
 *
 * @param {string} row
 */
export function extractRefs(row) {
  const refs = []
  const re = /\[?([a-z-]+)?#(\d+)\]?/gi
  let m
  while ((m = re.exec(row)) !== null) {
    const prefix = m[1]
    const repo = prefix ? (REPO_PREFIXES[prefix] ?? null) : DEFAULT_REPO
    if (!repo) continue
    const key = `${repo}#${m[2]}`
    if (!refs.includes(key)) refs.push(key)
  }
  return refs
}

/**
 * The row's primary class.
 *
 * Rows carry up to three tags, which is why the tag counts do not sum to the
 * row count and why no ranking was possible. The **first** tag is taken as
 * primary — it is the shape the author reached for first — and the rest are
 * kept as secondary rather than discarded.
 *
 * @param {string} cell
 */
export function parseClasses(cell) {
  const found = []
  for (const c of CLASSES) {
    const at = cell.toLowerCase().indexOf(c)
    if (at !== -1) found.push({ c, at })
  }
  found.sort((a, b) => a.at - b.at)
  const all = found.map((f) => f.c)
  return { primary: all[0] ?? null, secondary: all.slice(1) }
}

/**
 * A wall-clock cost stated in the row, in minutes.
 *
 * Only ever reads a cost the row actually states — "cost **1h 44m**". Absent
 * means `null`, never zero: a defect whose cost nobody recorded is not a free
 * defect, and averaging it in as one would understate every ranking.
 *
 * @param {string} row
 */
export function parseCost(row) {
  const m = /cost(?:\w*)?\s*\**\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(row)
  if (!m || (!m[1] && !m[2])) return null
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)
}

/** Status keyword the row ends with. */
export function parseStatus(cell) {
  const text = cell.toLowerCase()
  for (const s of [
    'fixed downstream',
    'partly fixed',
    'worked around',
    'unfiled',
    'closed',
    'fixed',
    'open',
  ]) {
    if (text.includes(s)) return s
  }
  return 'unknown'
}

/** Strip markdown links/emphasis so the summary reads as plain text. */
export function plain(cell) {
  return cell
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse the scoreboard table out of the markdown page.
 *
 * @param {string} markdown
 */
export function extractRows(markdown) {
  const rows = []
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue
    // Split on UNESCAPED pipes only. A cell may legitimately contain `\|` — a
    // markdown-escaped pipe, e.g. a shell pipeline quoted inside a row. Splitting
    // on every `|` turns such a row into 7 columns, so the destructure below
    // lands `class` on the tail of the condition, `parseClasses` finds no primary,
    // and the row is dropped **silently**.
    //
    // That was the long-standing row-count discrepancy this page flagged twice
    // and could not locate ("the extractor silently drops a row it cannot
    // parse"). Exactly one row triggers it: the `js-dependency-audit.sh` row,
    // which quotes `echo "$out" \| jq`. A generator that under-reports without
    // saying so is worse than a hand count, because it carries the authority of
    // having been computed.
    const cells = line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => c.replace(/\\\|/g, '|'))
    if (cells.length < 6) continue
    const [ref, condition, klass, surfaced, fixes, status] = cells.map((c) => c.trim())
    // Skip the header and its separator, and the small legend table above.
    if (/^#$/.test(ref) || /^-+$/.test(ref) || ref === 'Class') continue
    if (!condition || /^Meaning$/i.test(klass)) continue
    const { primary, secondary } = parseClasses(klass)
    if (!primary) continue
    rows.push({
      refs: extractRefs(line),
      summary: plain(condition),
      class: primary,
      alsoClass: secondary,
      surfacedIn: plain(surfaced),
      fixesIn: plain(fixes),
      status: parseStatus(status),
      costMinutes: parseCost(line),
      date: null,
    })
  }
  return rows
}

/**
 * Carry forward what a previous run already established.
 *
 * `--extract` re-reads the markdown, which is the source of truth for the row
 * *text* — but not for its recovered `date`, which came from GitHub and costs
 * an API call per row. Without this, adding one row to the table and
 * re-extracting would silently discard the dates on the other forty, and the
 * analysis would quietly report worse coverage than it has.
 *
 * Rows are matched on their summary text, which is stable across re-extraction
 * in a way that row order is not.
 *
 * @param {Array<Record<string, any>>} fresh
 * @param {Array<Record<string, any>>} existing
 */
export function mergeExtracted(fresh, existing) {
  const bySummary = new Map(existing.map((r) => [r.summary, r]))
  const merged = fresh.map((row) => {
    const prior = bySummary.get(row.summary)
    if (!prior) return row
    return {
      ...row,
      // The markdown wins on everything it states; the enrichment wins only
      // where the markdown says nothing.
      date: row.date ?? prior.date ?? null,
      costMinutes: row.costMinutes ?? prior.costMinutes ?? null,
    }
  })
  // Orphans are KEPT, not dropped.
  //
  // This used to `return fresh.map(...)`, which silently deleted every stored
  // row the markdown no longer mentioned. That is a data-loss fail-open, and it
  // fired: running `--extract` from a branch whose markdown predated another
  // session's rows rewrote evidence.jsonl without them, and the loss was
  // invisible because the counts it feeds simply got smaller.
  //
  // Deleting a row is legitimate, but it has to be *deliberate*. Keeping the
  // orphan and reporting it makes an accidental loss a no-op and an intentional
  // one an explicit edit to this file.
  return [...merged, ...orphanedRows(fresh, existing)]
}

/**
 * Stored rows the freshly-extracted markdown no longer mentions.
 *
 * Usually one of two things: a row genuinely deleted from the table, or — the
 * case this exists for — an extract run against a stale markdown that never had
 * another session's rows in the first place.
 *
 * @param {Array<Record<string, any>>} fresh
 * @param {Array<Record<string, any>>} existing
 */
export function orphanedRows(fresh, existing) {
  const freshSummaries = new Set(fresh.map((r) => r.summary))
  return existing.filter((r) => !freshSummaries.has(r.summary))
}

/** @param {string} file */
export function readEvidence(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

/**
 * Regenerate the analysis from the records.
 *
 * This is the whole point: the narrative is derived, so it cannot say
 * "fail-open is dominant" while the rows say otherwise.
 *
 * @param {Array<Record<string, any>>} rows
 */
export function analyse(rows) {
  const byClass = {}
  for (const c of CLASSES) byClass[c] = rows.filter((r) => r.class === c).length
  const withCost = rows.filter((r) => typeof r.costMinutes === 'number')
  const withDate = rows.filter((r) => r.date)
  const ranked = Object.entries(byClass).sort((a, b) => b[1] - a[1])

  return {
    rows: rows.length,
    byClass,
    dominant: ranked[0]?.[0] ?? null,
    dominantCount: ranked[0]?.[1] ?? 0,
    rarest: ranked[ranked.length - 1]?.[0] ?? null,
    coverage: {
      withCost: withCost.length,
      withDate: withDate.length,
      costHours: withCost.length
        ? Math.round((withCost.reduce((s, r) => s + r.costMinutes, 0) / 60) * 10) / 10
        : null,
    },
    byStatus: rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {}),
    // Where the work lands: the gap the page exists to expose.
    surfacedNotFixedHere: rows.filter(
      (r) => r.surfacedIn && r.fixesIn && !r.fixesIn.includes(r.surfacedIn.split(' ')[0]),
    ).length,
    byFixRepo: tallyFixRepos(rows),
  }
}

/**
 * The "Where the work actually lands" table, derived rather than typed.
 *
 * That table has now gone stale three times — most recently claiming 44 rows
 * against a scoreboard holding 47, while its headline ("0 fixes land in a plugin
 * repo") had already been falsified by two rows. A hand-maintained count beside a
 * hand-maintained table drifts by default, and the page's own advice is to
 * generate these figures; until this existed there was nothing to generate them
 * with.
 *
 * Longest-name-first matters: `biffo-plugin-idea-scout` contains neither
 * `biffo-platform` nor `biffo-plugin-ideation`, but `biffo-platform` IS a prefix
 * of `biffo-platform-app`, so a shorter name matching first would swallow the
 * longer one's rows. Each row counts a repo at most once, but may count several
 * repos — a fix landing in two places is two obligations, so the column
 * deliberately sums to more than the row count.
 *
 * @param {Array<Record<string, any>>} rows
 */
function tallyFixRepos(rows) {
  const known = [
    'biffo-plugin-idea-scout',
    'biffo-plugin-ideation',
    'biffo-platform-app',
    'biffo-template',
    'tabsii-platform',
    'biffo-platform',
    'tabsii-marketplace',
    'tabsii-intake',
    'biffo-runners',
    'tabsii-crm',
    'tabsii-geo',
    'tabsii-map',
  ]
  const tally = {}
  for (const row of rows) {
    if (!row.fixesIn) continue
    let rest = row.fixesIn
    for (const repo of known) {
      if (!rest.includes(repo)) continue
      tally[repo] = (tally[repo] ?? 0) + 1
      // Blank the match so a shorter repo name cannot re-match inside it.
      rest = rest.split(repo).join(' ')
    }
  }
  return Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1]))
}

function gh(path) {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 6e7 }))
}

function main() {
  const argv = process.argv.slice(2)
  const has = (f) => argv.includes(f)

  if (has('--extract')) {
    const fresh = extractRows(readFileSync(SOURCE, 'utf8'))
    const existing = readEvidence(EVIDENCE)
    const rows = mergeExtracted(fresh, existing)
    mkdirSync(dirname(EVIDENCE), { recursive: true })
    writeFileSync(EVIDENCE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const kept = rows.filter((r) => r.date).length
    // Loud, because the alternative is a dataset that quietly shrinks.
    const orphans = orphanedRows(fresh, existing)
    if (orphans.length > 0) {
      process.stderr.write(
        `\nWARNING: ${orphans.length} stored row(s) are not in the markdown and were KEPT.\n` +
          `If your checkout predates another session's rows, rebase before re-extracting.\n` +
          `To delete one deliberately, remove it from ${EVIDENCE} as well.\n`,
      )
      for (const row of orphans) process.stderr.write(`  - ${row.summary.slice(0, 90)}\n`)
    }
    process.stderr.write(
      `extracted ${rows.length} rows (${kept} keeping a known date) -> ${EVIDENCE}\n`,
    )
    return
  }

  if (has('--enrich')) {
    const rows = readEvidence(EVIDENCE)
    const cache = new Map()
    let dated = 0
    for (const row of rows) {
      if (row.date || row.refs.length === 0) continue
      // Earliest referenced item ≈ when the failure surfaced; later refs are fixes.
      let earliest = null
      for (const ref of row.refs) {
        const [repo, number] = ref.split('#')
        if (!cache.has(ref)) {
          try {
            cache.set(ref, gh(`repos/${repo}/issues/${number}`).created_at)
          } catch {
            cache.set(ref, null)
          }
        }
        const at = cache.get(ref)
        if (at && (earliest === null || at < earliest)) earliest = at
      }
      if (earliest) {
        row.date = earliest.slice(0, 10)
        dated += 1
      }
    }
    writeFileSync(EVIDENCE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    process.stderr.write(`dated ${dated} rows from GitHub\n`)
    return
  }

  const a = analyse(readEvidence(EVIDENCE))
  process.stdout.write(`${JSON.stringify(a, null, 2)}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('practices-evidence.mjs')) {
  main()
}
