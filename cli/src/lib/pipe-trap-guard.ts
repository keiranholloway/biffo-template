/**
 * The pipe trap, made enforceable (#1231, instance 1).
 *
 * `cmd | tail` reports **tail's** status, not `cmd`'s, so a failing command
 * reads as success:
 *
 * ```sh
 * sh scripts/claim.sh 1058 | tail -3 ; echo "exit: $?"   # always 0
 * ```
 *
 * AGENTS.md §4 has documented this for months, and it was hit **twice in one
 * session by the person who wrote the rule** — both times reporting `exit: 0`
 * for every issue checked, which is the one answer `claim.sh` is designed never
 * to give by accident (`2` means *cannot tell* and is never a pass). It has
 * also masked a `teardown` that reported success while destroying nothing, and
 * a rejected `git push` whose commits were then squash-merged missing.
 *
 * ## Why a guard here now, and not before
 *
 * Until 2026-08-03 these scripts existed in fifteen repos, so a guard in the
 * template proved nothing about the fourteen copies. Since #1109 there is one
 * canonical copy of each inside the published package, so checking it here
 * checks what every repo actually runs.
 *
 * ## Why this tokenises rather than greps
 *
 * A grep-based guard fires on its own fix: this file's own doc comment above
 * contains `| tail` and `$?`, and so does AGENTS.md. `no-raw-mkdtemp.test.ts`
 * (#1200) is the working precedent and walks the TypeScript AST for exactly
 * that reason. Shell has no comparable parser available here, so this strips
 * comments and quoted strings first and reasons about what remains — enough to
 * tell a real pipeline from a mention of one.
 */

/** A command whose exit status carries meaning that a pipe would discard. */
const STATUS_BEARING = [
  // Three-valued: 0 green, 1 failed, 2 cannot tell — and 2 is never a pass.
  /\bwait-for-checks\b/,
  /\bbranch-health\b/,
  /\bclaim\.sh\b/,
  /\bbiffo\.sh\s+(claim|wait-for-checks|branch-health|verify)\b/,
  // Push rejection is how commits get silently lost (AGENTS.md §4).
  /\bgit\s+push\b/,
  /\bverify\.sh\b/,
]

/**
 * Flags that turn a status-bearing command into a QUERY, where the output is
 * the answer and the exit code is not.
 *
 * `sh scripts/verify.sh --list | grep -oE ...` is correct shell: the caller
 * wants the names of the checks, and piping them discards nothing that was
 * meant to be read. Both live uses in this repo (`gate-coverage.sh`,
 * `shared-sync.sh`) are exactly that, and flagging them would have made the
 * guard noise on day one — which is how a guard stops being read.
 */
const QUERY_FLAGS = [/--list\b/, /--help\b/, /--version\b/]

export interface PipeTrap {
  line: number
  text: string
  reason: string
}

/**
 * Remove comments and quoted strings, preserving line structure so reported
 * line numbers still point at the source. A `#` only starts a comment at the
 * beginning of a word — `${x#prefix}` and `foo#bar` are not comments.
 */
function strip(source: string): string[] {
  return source.split('\n').map((raw) => {
    let out = ''
    let quote: string | null = null
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]
      if (quote) {
        // Inside single quotes nothing escapes, not even a backslash.
        if (c === '\\' && quote === '"') {
          i++
          continue
        }
        if (c === quote) {
          quote = null
          continue
        }
        // Parameter expansions survive inside DOUBLE quotes, and the canonical
        // failing line is `echo "exit: $?"` — dropping the whole string would
        // make the guard blind to the exact form that shipped. Single quotes
        // expand nothing, so `'$?'` really is just text.
        if (c === '$' && quote === '"') {
          out += c + (raw[i + 1] ?? '')
          i++
        }
        continue
      }
      if (c === '"' || c === "'") {
        quote = c
        continue
      }
      if (c === '\\') {
        i++
        continue
      }
      if (c === '#' && (out === '' || /\s/.test(out[out.length - 1] ?? ''))) break
      out += c
    }
    return out
  })
}

/** True when the line contains a real pipeline — `|` but not `||`. */
function isPipeline(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '|') continue
    if (line[i + 1] === '|') {
      i++
      continue
    }
    if (line[i - 1] === '|') continue
    return true
  }
  return false
}

/**
 * Find every place a pipeline discards a status that matters, or `$?` is read
 * where it can only hold the tail's status.
 */
export function findPipeTraps(source: string): PipeTrap[] {
  const lines = strip(source)
  const traps: PipeTrap[] = []
  let lastWasPipeline = false

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === '') return

    if (isPipeline(line)) {
      const head = line.split('|')[0] ?? ''
      const matched = STATUS_BEARING.find((p) => p.test(head))
      const isQuery = QUERY_FLAGS.some((p) => p.test(head))
      if (matched && !isQuery) {
        traps.push({
          line: index + 1,
          text: trimmed,
          reason: `a status-bearing command upstream of a pipe — the pipeline reports the LAST command's status, so this can only ever read 0`,
        })
      }
    }

    // `$?` on the line after a pipeline reads the tail's status. Same defect,
    // written across two lines, which is the form that actually shipped.
    if (lastWasPipeline && /\$\?/.test(line)) {
      traps.push({
        line: index + 1,
        text: trimmed,
        reason: `$? read directly after a pipeline — that is the LAST command's status, not the one you meant. Use \${PIPESTATUS[0]}, or drop the pipe`,
      })
    }

    lastWasPipeline = isPipeline(line)
  })

  return traps
}
