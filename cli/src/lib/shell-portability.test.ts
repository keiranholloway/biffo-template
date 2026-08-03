import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A script that will be run by `sh` must be valid POSIX `sh`.
 *
 * ## Why
 *
 * On Ubuntu — the CI runner and this workstation — `/bin/sh` is **dash**. A
 * bash-only construct in a script that AGENTS.md invokes as `sh scripts/x.sh`
 * is therefore never exercised by its documented invocation until it misbehaves
 * in front of someone. Both failure modes bit `branch-health.sh` while it was
 * being written (#1133), and they are worth separating because **only one of
 * them is a syntax error**:
 *
 * 1. `IFS=$'\t'` — valid syntax under dash and silently *wrong*. dash has no
 *    `$'...'` form, so it reads the literal characters `$ ' \ t` and splits
 *    fields on any of them. "Deploy Application" was split at its `t` and
 *    reported as a workflow called "Deploy Applica". `sh -n` cannot see this.
 * 2. An unbalanced quote — a genuine parse error, but one that surfaced at
 *    *runtime*, ~100 lines after all the useful output had printed, turning a
 *    correct exit 1 into a confusing exit 2.
 *
 * So both a parse check and a pattern scan are needed; neither subsumes the
 * other.
 *
 * ## Scope is derived, not assumed
 *
 * The first draft of this test checked **every** `scripts/*.sh` and failed 12,
 * because most of them are honest bash scripts that nothing ever runs with
 * `sh` — `practices-daily.sh` is invoked by cron as bash and is entitled to
 * bash. A guard that is red on correct code is one people learn to suppress.
 *
 * So the set is computed: a script must be POSIX if **either** its shebang says
 * `sh`, **or** something in the repo invokes it as `sh <path>`. That also
 * catches the genuinely dangerous shape — a `#!/usr/bin/env bash` shebang on a
 * script AGENTS.md tells you to run with `sh`, where the shebang is a promise
 * the invocation does not keep (`shared-sync.sh`, `wait-for-checks.sh` and
 * `branch-health.sh` are all in that position today).
 *
 * ## Why the scan strips comments and strings
 *
 * A guard that greps raw lines fires on its own explanation: the comment in
 * `branch-health.sh` documenting the `IFS=$'\t'` trap contains the banned
 * pattern. And `[[` must not match `[[:space:]]`, a POSIX character class — the
 * first draft flagged `verify.sh` and `pg-test-db.sh` for exactly that, which
 * is why `[[` is now anchored to command position.
 */

// cli/src/lib/ -> cli/src/ -> cli/ -> repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function scriptDirs(): string[] {
  const dirs = [join(repoRoot, 'scripts')]
  const skeletons = join(repoRoot, '_skeletons')
  if (existsSync(skeletons)) {
    for (const entry of readdirSync(skeletons, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(skeletons, entry.name, 'scripts')
      if (existsSync(dir)) dirs.push(dir)
    }
  }
  return dirs
}

function allShellScripts(): string[] {
  return scriptDirs()
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.sh'))
        .map((name) => join(dir, name)),
    )
}

/**
 * Places that name a script and the interpreter to run it with.
 *
 * Deliberately excludes `.husky/`: it is not distributed to instances, so
 * naming it here would make this test a repo-layout assertion that reds an
 * instance's CI (`repo-layout-assertion-guard.test.ts` catches exactly that,
 * and caught this file on the first run). Nothing is lost — every script the
 * hooks invoke already carries an `sh` shebang, so route 1 covers them.
 */
function invocationSources(): string[] {
  const files = [
    join(repoRoot, 'AGENTS.md'),
    join(repoRoot, 'CLAUDE.md'),
    join(repoRoot, 'scripts/biffo.sh'),
  ].filter((p) => existsSync(p))

  const workflows = join(repoRoot, '.github/workflows')
  if (existsSync(workflows)) {
    for (const entry of readdirSync(workflows, { withFileTypes: true })) {
      if (entry.isFile()) files.push(join(workflows, entry.name))
    }
  }
  return files
}

/** Basenames the repo runs via `sh <path>`. */
function invokedAsSh(): Set<string> {
  const names = new Set<string>()
  for (const file of invocationSources()) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(/\bsh\s+(?:"\$GITHUB_WORKSPACE"\/)?[\w./-]*?([\w-]+\.sh)\b/g)) {
      if (m[1] !== undefined) names.add(m[1])
    }
  }
  return names
}

function shebang(file: string): string {
  return readFileSync(file, 'utf8').split('\n')[0] ?? ''
}

/** Scripts that must be POSIX: shebang says sh, or something runs them with sh. */
function mustBePosix(): { file: string; reason: string }[] {
  const shInvoked = invokedAsSh()
  const out: { file: string; reason: string }[] = []
  for (const file of allShellScripts()) {
    const base = file.split('/').pop() ?? ''
    const line = shebang(file)
    const shShebang = /^#!.*\b(?:\/|env\s+)sh\s*$/.test(line)
    if (shShebang) out.push({ file, reason: 'shebang declares sh' })
    else if (shInvoked.has(base)) out.push({ file, reason: `invoked as \`sh ${base}\`` })
  }
  return out
}

/** Strip comments so the scan sees code, not documentation about the ban. */
function codeOnly(source: string): string[] {
  return source.split('\n').map((line) => {
    if (line.trimStart().startsWith('#')) return ''
    return line.replace(/\s#\s.*$/, '')
  })
}

const BASHISMS: { pattern: RegExp; name: string; why: string }[] = [
  {
    pattern: /(?:^|[\s=(])\$'/,
    name: "$'...' ANSI-C quoting",
    why: "dash has no $'...' form and reads it literally. Use TAB=$(printf '\\t') then \"$TAB\".",
  },
  {
    // Command position only: `[[` after start-of-line, `;`, `&&`, `||`, `(` or
    // `!`, and followed by whitespace. Never `[[:space:]]` or a regex `\[[0-9]`.
    pattern: /(?:^|[;&|(!]|\bif|\bwhile|\buntil|\belif)\s*\[\[\s/,
    name: '[[ ]] test',
    why: 'Not POSIX. Use [ ] or case.',
  },
  { pattern: /<<</, name: '<<< herestring', why: 'Not POSIX. Use a heredoc or a pipe.' },
  {
    pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*\^\^?[\s}]/,
    name: '${var^^} case conversion',
    why: 'Not POSIX. Use tr.',
  },
  {
    pattern: /\bPIPESTATUS\b/,
    name: 'PIPESTATUS',
    why: 'bash-only. Restructure so the checked command is last, or use a temp file.',
  },
]

describe('scripts that sh will run are POSIX sh', () => {
  const targets = mustBePosix()

  /**
   * A sweep reporting zero because it read nothing is this estate's most
   * repeated defect — #1145 reported "27 branches, all protected" while
   * dropping the four least likely to be protected. Pin that it found files,
   * and that its derived scope really did derive something.
   */
  it('derived a non-empty scope, from both routes', () => {
    expect(allShellScripts().length, 'no .sh files found — has the layout moved?').toBeGreaterThan(
      10,
    )
    expect(targets.length, 'no script requires POSIX — the derivation is broken').toBeGreaterThan(5)

    const reasons = new Set(
      targets.map((t) => (t.reason.startsWith('invoked') ? 'invoked' : 'shebang')),
    )
    expect(
      [...reasons].sort(),
      'one of the two derivation routes found nothing — check the invocation scan',
    ).toEqual(['invoked', 'shebang'])
  })

  it.each(targets.map((t) => [relative(repoRoot, t.file), t.file, t.reason]))(
    'parses as POSIX sh: %s',
    (label, file, reason) => {
      let error = ''
      try {
        execFileSync('sh', ['-n', file], { stdio: 'pipe' })
      } catch (err) {
        error = String((err as { stderr?: Buffer }).stderr ?? (err as Error).message)
      }
      expect(
        error,
        error === '' ? '' : `\n${label} (${reason}) is not valid POSIX sh:\n${error}`,
      ).toBe('')
    },
  )

  it.each(targets.map((t) => [relative(repoRoot, t.file), t.file, t.reason]))(
    'uses no bashisms: %s',
    (label, file, reason) => {
      const found: string[] = []
      codeOnly(readFileSync(file, 'utf8')).forEach((line, i) => {
        for (const { pattern, name, why } of BASHISMS) {
          if (pattern.test(line)) {
            found.push(`  ${label}:${i + 1} (${reason})  ${name}\n    ${line.trim()}\n    ${why}`)
          }
        }
      })
      expect(found, found.length === 0 ? '' : `\n${found.join('\n')}\n`).toEqual([])
    },
  )
})
