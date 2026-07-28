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
 * Runs on bare node with no install, like every other script here.
 *
 * Usage:  node scripts/practices-monotonic.mjs [baseRef]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

export const EVIDENCE = 'docs/practices/evidence.jsonl'
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
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trimEnd()
    if (!isRow(line) || isSeparator(line)) continue
    // The line immediately before a separator is that table's header.
    if (i + 1 < lines.length && isSeparator(lines[i + 1].trimEnd())) continue
    count += 1
  }
  return count
}

/** True when any commit in the range explains a deliberate removal. */
export function hasRemovalTrailer(commitMessages) {
  return commitMessages.includes(REMOVAL_TRAILER)
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

function main() {
  const baseRef = process.argv[2] ?? process.env['GITHUB_BASE_REF'] ?? 'dev'
  // No corpus in this repo — every instance scaffolded from the template runs
  // this check and has neither file. Silence, not failure.
  if (!existsSync(EVIDENCE) && !existsSync(MARKDOWN)) return

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

  const base = {
    evidence: countEvidence(git(['show', `${mergeBase}:${EVIDENCE}`])),
    tableRows: countTableRows(git(['show', `${mergeBase}:${MARKDOWN}`])),
  }
  const head = {
    evidence: countEvidence(existsSync(EVIDENCE) ? readFileSync(EVIDENCE, 'utf8') : ''),
    tableRows: countTableRows(existsSync(MARKDOWN) ? readFileSync(MARKDOWN, 'utf8') : ''),
  }
  const messages = git(['log', '--format=%B', `${mergeBase}..HEAD`])
  const { losses, ok } = assess(base, head, hasRemovalTrailer(messages))

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
