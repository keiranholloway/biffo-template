/**
 * Fail a PR that DELETES recorded practices evidence.
 *
 * ## Why this exists
 *
 * `docs/practices/evidence.jsonl` and the scoreboard in
 * `docs/guides/development-practices.md` are append-only corpora that several
 * agent sessions write to concurrently. In roughly 24 hours they lost content
 * three times:
 *
 *   - 07-27 19:41 → 20:42, evidence.jsonl went 65 → 53 rows, silently.
 *   - A branch rewrote the markdown wholesale from a stale base and squash-merged
 *     an hour later: 215 insertions against 322 deletions, no conflict, because
 *     a full-file replacement from a stale base merges cleanly. It deleted 18
 *     scoreboard rows and 23 narrative entries from three different sessions
 *     (restored by #762).
 *   - #774 deleted 93 lines from a base that was NOT stale — created and merged
 *     within two minutes — and needed restoring by #777.
 *
 * Every one was found by a human noticing the row count had gone *down*, then
 * doing git archaeology. Nothing failed. `mergeExtracted` warns on stderr, which
 * nobody reads in a green run.
 *
 * That is this project's signature failure — something continued after it should
 * have stopped, and nothing downstream could tell — applied to the very dataset
 * that records it.
 *
 * ## What it does
 *
 * Compares the two corpora against the merge base and fails if either shrank.
 * Deliberately counts, rather than diffing content: rewording a row is normal
 * and constant, losing one is not, and a count is the one signal that cannot be
 * argued with.
 *
 * ## The escape hatch, and why it is a trailer
 *
 * Rows *should* sometimes be removed — a genuine duplicate, a row merged into
 * another. So a decrease is allowed when a commit in the PR carries:
 *
 *     Practices-Removal: <why>
 *
 * A trailer rather than a flag, matching `Core-Divergence:` — it lands in
 * history, so the removal is reviewable later rather than being a decision
 * someone made in a terminal.
 *
 * ## The directory (#1132)
 *
 * `evidence.jsonl` is now a frozen legacy file — new findings are written as
 * their own file under `docs/practices/evidence/`, one per entry, so
 * concurrent sessions never touch the same path and cannot conflict. The
 * shrink check above is exactly wrong for a directory: two sessions ADDING a
 * file apiece can never collide, so growth is not the interesting property.
 * The one way this corpus loses a finding is a file vanishing, so the
 * directory's guard is simpler and stronger than "never shrinks" — **no path
 * present at the merge base is missing now**. Same escape hatch
 * (`Practices-Removal:`), because a genuine duplicate or merge still needs a
 * way out.
 *
 * Runs on bare node with no install, like every other script here.
 *
 * Usage:  node scripts/practices-monotonic.mjs [baseRef]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

export const EVIDENCE = 'docs/practices/evidence.jsonl'
export const EVIDENCE_DIR = 'docs/practices/evidence'
export const MARKDOWN = 'docs/guides/development-practices.md'
export const REMOVAL_TRAILER = 'Practices-Removal:'

/** Non-blank lines — one JSON record each. */
export function countEvidence(text) {
  if (!text) return 0
  return text.split('\n').filter((line) => line.trim() !== '').length
}

/**
 * Data rows across **every** table in the markdown.
 *
 * Counting rows rather than lines keeps the check indifferent to reflowed
 * prose, which changes constantly and is not evidence.
 *
 * Counting *every* table, not just the scoreboard, is the correction that makes
 * this guard work. Scored on the real incidents, a scoreboard-only count caught
 * the 65 → 53 drop and **missed #774 entirely** — because #774's 93 deleted
 * lines included 50 rows from the *"Where the cycles go"* and *"Skills used"*
 * tables, which have three cells rather than six. Those are the sections
 * recording what things cost and whether a skill worked; losing them silently
 * is exactly as bad, and a guard tuned to one table shape would have passed it.
 *
 * A header is identified by the separator line that follows it, so no table's
 * column names need to be known in advance.
 */
export function countTableRows(text) {
  if (!text) return 0
  const lines = text.split('\n')
  const isRow = (l) => l.startsWith('|')
  const isSeparator = (l) => isRow(l) && /^\|[\s:|-]+\|?\s*$/.test(l)
  let count = 0
  // Rows inside a `<!-- BEGIN generated: … -->` region are DERIVED, not evidence.
  // Counting them made the guard react to tally churn: regenerating a tally after
  // an append changes these counts for reasons that have nothing to do with
  // whether anyone lost a finding, and removing the generated blocks entirely
  // (#953) reads as a 14-row loss when nothing was lost at all. The guard exists
  // to protect what a human wrote; that is the only thing it should count.
  let inGenerated = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trimEnd()
    if (/^<!--\s*BEGIN generated:/.test(line)) {
      inGenerated = true
      continue
    }
    if (/^<!--\s*END generated:/.test(line)) {
      inGenerated = false
      continue
    }
    if (inGenerated) continue
    if (!isRow(line) || isSeparator(line)) continue
    // The line immediately before a separator is that table's header.
    if (i + 1 < lines.length && isSeparator(lines[i + 1].trimEnd())) continue
    count += 1
  }
  return count
}

/**
 * Rows whose `summary` already appears earlier in the corpus.
 *
 * The append-only guard asserts the file **grows**; it cannot tell growth from
 * duplication. A botched conflict resolution on `evidence.jsonl` — the shape
 * that actually happens, because both sides append — satisfies "bigger than
 * before" while double-counting findings, and every share and ranking derived
 * from the corpus is then wrong in a direction nobody checks.
 *
 * Compared against the merge base rather than asserted at zero: one duplicate
 * is already present, and a gate that fails on somebody else's pre-existing
 * damage gets disabled rather than fixed. Introducing a NEW one fails.
 *
 * Matched on the first 120 characters, because a re-worded duplicate is a
 * judgement call but a copy is not.
 *
 * @param {string} text raw JSONL
 */
export function countDuplicateSummaries(text) {
  if (!text) return 0
  const seen = new Set()
  let duplicates = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      // A malformed line is not this guard's business — the parse gate owns it.
      continue
    }
    const key = String(row?.summary ?? '').slice(0, 120)
    if (key === '') continue
    if (seen.has(key)) duplicates += 1
    seen.add(key)
  }
  return duplicates
}

/** True when any commit in the range explains a deliberate removal. */
export function hasRemovalTrailer(commitMessages) {
  return commitMessages.includes(REMOVAL_TRAILER)
}

/**
 * The per-directory equivalent of "never shrinks": no path is ever DELETED.
 *
 * A count cannot express this correctly for a directory the way it does for
 * a single file — two sessions each ADDING one file grows the count exactly
 * as much as one session deleting a different one and adding two, so "grew"
 * proves nothing. Deletion is the only loss shape a per-entry directory can
 * suffer, so it is what gets checked, directly.
 *
 * @param {string[]} baseFiles filenames present at the merge base
 * @param {string[]} headFiles filenames present now
 */
export function assessDeletions(baseFiles, headFiles) {
  const headSet = new Set(headFiles)
  const deleted = baseFiles.filter((f) => !headSet.has(f))
  return { deleted, ok: deleted.length === 0 }
}

/**
 * @param {{evidence: number, tableRows: number}} base
 * @param {{evidence: number, tableRows: number}} head
 * @param {boolean} acknowledged
 */
export function assess(base, head, acknowledged) {
  const losses = []
  if (head.evidence < base.evidence) {
    losses.push({ what: EVIDENCE, from: base.evidence, to: head.evidence })
  }
  if (head.tableRows < base.tableRows) {
    losses.push({ what: `${MARKDOWN} (table rows)`, from: base.tableRows, to: head.tableRows })
  }
  return { losses, ok: losses.length === 0 || acknowledged, acknowledged }
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/**
 * `*.json` paths under `dir` at git ref `ref`. Empty, not an error, when the
 * directory does not exist there yet — every PR predating #1132 has none.
 */
function listDirAtRef(ref, dir) {
  const out = git(['ls-tree', '-r', '--name-only', ref, '--', dir])
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.json'))
}

/** `*.json` paths under `dir` on disk right now. */
function listDirNow(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => `${dir}/${f}`)
}

function main() {
  const baseRef = process.argv[2] ?? process.env['GITHUB_BASE_REF'] ?? 'dev'
  // No corpus in this repo — every instance scaffolded from the template runs
  // this check and has neither file nor directory. Silence, not failure.
  if (!existsSync(EVIDENCE) && !existsSync(MARKDOWN) && !existsSync(EVIDENCE_DIR)) return

  const mergeBase = git(['merge-base', `origin/${baseRef}`, 'HEAD']).trim()
  if (!mergeBase) {
    // Cannot establish a base: a shallow clone, or a detached build. Say so and
    // pass — a guard that cannot run must not invent a verdict, in either
    // direction.
    process.stderr.write(
      `practices-monotonic: no merge base against origin/${baseRef}; skipping (not a pass).\n`,
    )
    return
  }

  const baseEvidenceText = git(['show', `${mergeBase}:${EVIDENCE}`])
  const headEvidenceText = existsSync(EVIDENCE) ? readFileSync(EVIDENCE, 'utf8') : ''
  const base = {
    evidence: countEvidence(baseEvidenceText),
    tableRows: countTableRows(git(['show', `${mergeBase}:${MARKDOWN}`])),
  }
  const head = {
    evidence: countEvidence(headEvidenceText),
    tableRows: countTableRows(existsSync(MARKDOWN) ? readFileSync(MARKDOWN, 'utf8') : ''),
  }
  const messages = git(['log', '--format=%B', `${mergeBase}..HEAD`])
  const { losses, ok } = assess(base, head, hasRemovalTrailer(messages))

  // Growth is not enough: a botched merge on an append-only file can double
  // rows and satisfy every count above. Checked separately so its message can
  // name the actual remedy, which is not "rebase" but "re-append only your own
  // rows onto the other side's file".
  const baseDupes = countDuplicateSummaries(baseEvidenceText)
  const headDupes = countDuplicateSummaries(headEvidenceText)
  if (headDupes > baseDupes) {
    process.stderr.write(
      `\npractices-monotonic: duplicate summaries ${baseDupes} → ${headDupes} ` +
        `(+${headDupes - baseDupes}).\n\n` +
        `The corpus grew, but by copying rows rather than adding findings — which the\n` +
        `append-only check cannot see, and which silently skews every share and ranking\n` +
        `derived from it.\n\n` +
        `This is what a wrong conflict resolution on evidence.jsonl looks like. The fix\n` +
        `is NOT to union both sides: take origin/${baseRef}'s file and re-append only the\n` +
        `rows your branch added.\n`,
    )
    process.exit(1)
  }

  // The directory's own check: no path present at the merge base may be
  // missing now. Separate from `losses` above because the remedy and the
  // framing are different — a count regressing asks "did this shrink?", a
  // directory asks "is everything that was here still here?".
  const baseDirFiles = listDirAtRef(mergeBase, EVIDENCE_DIR)
  const headDirFiles = listDirNow(EVIDENCE_DIR)
  const { deleted, ok: dirOk } = assessDeletions(baseDirFiles, headDirFiles)
  if (!dirOk && !hasRemovalTrailer(messages)) {
    process.stderr.write(
      `\npractices-monotonic: ${deleted.length} file(s) deleted from ${EVIDENCE_DIR}:\n` +
        deleted.map((f) => `  - ${f}\n`).join('') +
        `\nThis directory exists so concurrent sessions never touch the same path —\n` +
        `each finding is its own file, so the only way it loses one is a file\n` +
        `vanishing outright. If this was deliberate (a genuine duplicate, two rows\n` +
        `merged), say so in a commit:\n\n` +
        `    ${REMOVAL_TRAILER} merged two rows recording the same condition\n\n` +
        `Otherwise you are probably editing from a stale base. Rebase onto\n` +
        `origin/${baseRef} and re-apply.\n`,
    )
    process.exit(1)
  }
  if (!dirOk) {
    process.stderr.write(
      `practices-monotonic: ${deleted.length} file(s) deleted from ${EVIDENCE_DIR} ` +
        `(allowed: a commit carries ${REMOVAL_TRAILER}).\n`,
    )
  }

  for (const loss of losses) {
    process.stderr.write(
      `practices-monotonic: ${loss.what} shrank ${loss.from} → ${loss.to} (-${loss.from - loss.to}).\n`,
    )
  }
  if (ok) {
    if (losses.length > 0) {
      process.stderr.write(`  Allowed: a commit carries ${REMOVAL_TRAILER}\n`)
    }
    return
  }
  process.stderr.write(
    `\nThis corpus is append-only and several sessions write to it at once. It has\n` +
      `lost content three times in 24h, every time via a wholesale rewrite that\n` +
      `merged without a conflict, and every time found by a human noticing the\n` +
      `count had gone down.\n\n` +
      `If rows were genuinely merged or de-duplicated, say so in a commit:\n\n` +
      `    ${REMOVAL_TRAILER} merged two rows recording the same --auto condition\n\n` +
      `Otherwise you are probably editing from a stale base, or replacing the file\n` +
      `rather than appending to it. Rebase onto origin/${baseRef} and re-apply.\n`,
  )
  process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith('practices-monotonic.mjs')) {
  main()
}
