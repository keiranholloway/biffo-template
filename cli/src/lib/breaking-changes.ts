import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareCoreVersions, parseCoreVersion } from './core-version.js'

/**
 * Surface the documented breaking changes an upgrade crosses (issue #407).
 *
 * ## Why this exists
 *
 * `docs/guides/core-upgrade.md` has a **Breaking changes by version** section
 * whose own preamble says:
 *
 * > A few changes destroy data or require manual work, and Terraform will apply
 * > them without ceremony — a Cognito pool replacement reads as an ordinary
 * > `-/+ resource` line in a plan nobody scrolls through. Check this list before
 * > upgrading past a version in it.
 *
 * "Check this list" was the entire safety mechanism, and it depended on a human
 * remembering the list exists. Upgrading an instance from 0.49.2 to 0.53.0
 * crossed 0.50.0 — which replaces the Cognito user pool and deletes every user
 * in it — and nothing in the plan or the PR said so. It was found by reading the
 * commit log between two tags by hand, which is not a process.
 *
 * The CLI has both versions and the guide in hand. Nothing needed inventing.
 *
 * ## Parsed, not duplicated
 *
 * The entries are read from the guide rather than a parallel machine-readable
 * file. A second file cannot disagree with the prose if there is no second file
 * — and the obvious objection, that parsing prose is brittle, is answered by
 * `breaking-changes.test.ts`, which asserts the parse finds the entries that
 * really exist. A heading typo turns a test red instead of silently disabling
 * the warning.
 */

export const UPGRADE_GUIDE_PATH = 'docs/guides/core-upgrade.md'
const SECTION_HEADING = '## Breaking changes by version'

/** `### 0.50.0 — the email address becomes the sign-in identity` */
const ENTRY_HEADING = /^###\s+(\d+\.\d+\.\d+)\s*[—-]\s*(.+?)\s*$/

export interface BreakingChange {
  version: string
  title: string
  /** The prose under the heading, trimmed. What the reader must actually do. */
  body: string
}

/**
 * Parse the guide's breaking-change entries, in document order.
 *
 * Only the **Breaking changes by version** section is read: `###` headings
 * elsewhere in the guide are ordinary subsections and must not be mistaken for
 * release entries.
 */
export function parseBreakingChanges(guide: string): BreakingChange[] {
  const lines = guide.split('\n')
  const start = lines.findIndex((l) => l.trim() === SECTION_HEADING)
  if (start === -1) return []

  const entries: BreakingChange[] = []
  let current: BreakingChange | null = null

  for (const line of lines.slice(start + 1)) {
    // Any other `##` heading ends the section.
    if (/^##\s/.test(line) && !/^###/.test(line)) break

    const match = ENTRY_HEADING.exec(line)
    if (match?.[1] && match[2]) {
      if (current) entries.push({ ...current, body: current.body.trim() })
      current = { version: match[1], title: match[2], body: '' }
      continue
    }
    if (current) current.body += `${line}\n`
  }
  if (current) entries.push({ ...current, body: current.body.trim() })
  return entries
}

/** Read and parse the guide from a template checkout. Absent guide = no entries,
 * so a template that predates the section does not break the upgrade. */
export function readBreakingChanges(templateRoot: string): BreakingChange[] {
  const path = join(templateRoot, UPGRADE_GUIDE_PATH)
  if (!existsSync(path)) return []
  return parseBreakingChanges(readFileSync(path, 'utf8'))
}

/**
 * The entries an upgrade from *from* to *to* crosses: `from < version <= to`.
 *
 * Exclusive at the bottom, inclusive at the top. An instance already **on**
 * 0.50.0 has lived through it — warning again would be noise, and noise is what
 * makes the next warning ignorable. An instance moving **to** 0.50.0 is about
 * to, so it is told.
 */
export function breakingChangesBetween(
  from: string,
  to: string,
  entries: BreakingChange[],
): BreakingChange[] {
  // Validates both, so a malformed version fails loudly here rather than
  // silently comparing as strings and warning about nothing.
  parseCoreVersion(from)
  parseCoreVersion(to)
  return entries
    .filter(
      (e) => compareCoreVersions(e.version, from) > 0 && compareCoreVersions(e.version, to) <= 0,
    )
    .sort((a, b) => compareCoreVersions(a.version, b.version))
}
