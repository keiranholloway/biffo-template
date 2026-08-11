/**
 * A `// codeql[query-id]` comment does not suppress anything here (#1491).
 *
 * The convention started in `cli/src/lib/core-version.ts` and
 * `cli/src/lib/plugin-workspace-sources.ts` as a note explaining why a
 * `js/file-system-race` finding was accepted, and read — reasonably — as a
 * suppression mechanism: it sits directly above the flagged line and names the
 * query id, the way an ESLint `// eslint-disable-next-line` or a `# noqa`
 * genuinely would. It is not one. `.github/workflows/codeql.yml` carries no
 * `paths-ignore`/query-filter that reads source comments, and there is no
 * `.github/codeql/codeql-config.yml` in this repo at all — CodeQL never looks
 * at the comment, so the finding still fires. Verified against this repo's own
 * alert history: alert #21 (`js/file-system-race`,
 * `plugin-workspace-sources.ts:190`) was open with the comment sitting
 * directly above it, while alerts #12/#13 — the two matching findings this
 * convention was copied from — were `dismissed`/`won't fix` by an explicit API
 * or UI action, never by the comment.
 *
 * The real mechanisms are: dismissing the alert (UI or
 * `PATCH .../code-scanning/alerts/<n>` with a `dismissed_reason` and a
 * recorded comment — what alerts #12, #13 and #21 now all use), a
 * `paths-ignore`/query-filter block in `.github/codeql/codeql-config.yml`, or
 * an actual code fix. This guard asserts the convention this repo's history
 * showed does NOT work is not reintroduced — a real suppression NEVER needs a
 * `codeql[...]`-shaped comment in source, so any occurrence here is either the
 * dead convention creeping back or a new copy of the same false belief.
 *
 * Deliberately a comment scan, not an AST walk: this class is defined by a
 * false claim living in a *comment*, in any of the languages CodeQL scans here
 * (TS and Python), so the check has to look at exactly the text a human reads
 * — an AST pass would either not see comments at all or need per-language
 * parsers for no benefit over a plain scan of the marker string.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SKIP_DIRS = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  'dist',
  'build',
  '.venv',
  '.turbo',
  'coverage',
])

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.py'])

export interface CodeqlSuppressionHit {
  path: string
  line: number
  text: string
}

// Matches only a comment whose content STARTS with `codeql[...]` — the actual
// suppression-attempt shape (`// codeql[js/file-system-race]`, optionally with
// a trailing explanation). Deliberately does not fire on prose that merely
// *mentions* the pattern (e.g. this file's own docstring, or the reasoning
// left behind explaining why the convention was retired) — a grep with no
// such distinction fires on its own fix, the same trap `pipe-trap-guard.ts`
// documents at length for its subject matter.
const SUPPRESSION_COMMENT = /^\s*(?:\/\/|#|\*)\s*codeql\[[^\]]+\]/

/** Every line matching the dead `codeql[query-id]` comment shape. */
export function findCodeqlSuppressionComments(source: string): number[] {
  const lines = source.split('\n')
  const hits: number[] = []
  lines.forEach((line, index) => {
    if (SUPPRESSION_COMMENT.test(line)) hits.push(index + 1)
  })
  return hits
}

function walkSourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const p = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue
        walk(p)
        continue
      }
      const dot = entry.lastIndexOf('.')
      if (dot === -1) continue
      if (SCAN_EXTENSIONS.has(entry.slice(dot))) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

/** Every `codeql[...]`-shaped comment across the repo's source tree. */
export function sweepCodeqlSuppressionComments(root: string): CodeqlSuppressionHit[] {
  const hits: CodeqlSuppressionHit[] = []
  for (const path of walkSourceFiles(root)) {
    const text = readFileSync(path, 'utf8')
    for (const line of findCodeqlSuppressionComments(text)) {
      hits.push({ path, line, text: text.split('\n')[line - 1] ?? '' })
    }
  }
  return hits
}
