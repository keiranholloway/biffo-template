import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * A guard must not assert on the **text** of a file that parses (#956).
 *
 * ## The shape, which this estate has now recorded four times
 *
 * `expect(workflow).toContain('sh scripts/biffo.sh check plugin-collisions')`
 * asserts a *substring* while the invariant it means is *this exact command
 * runs*. Every superset satisfies it, so renaming the guard by extension —
 * `plugin-collisions` to `plugin-collisionsXX` — leaves the assertion green over
 * a workflow that no longer runs the guard at all (#718, #720). The same idiom
 * produced:
 *
 *  - a compliance guard asserting `"import User" not in source`, which passes
 *    only because that file happens never to say the words, and would fail a
 *    correct file that imported `UserProfile` (#949, and again in
 *    `test_identity_seam.py`);
 *  - `strings`/`grep` over a compressed artefact as a secret pre-check, which
 *    reported clean on a plan carrying a live private key (biffo-runners#1).
 *
 * `#956` calls these "literally the same bug in three places" and asks for a
 * lint. This is it.
 *
 * ## Why a lint, when both fixes already shipped
 *
 * They did, and that is the point. `assertRunsCommand`/`assertInvokes`
 * (`workflow-run-commands.ts`) split a workflow into the discrete commands it
 * runs so membership is exact; `test_identity_seam.py` walks the Python AST.
 * **Nothing makes anyone use either.** A new test can still be written with
 * `expect(workflow).toContain(...)` and nothing objects — and 15 such
 * assertions were still in the tree when this was written. A helper that exists
 * but is not reached for is how a fixed class comes back.
 *
 * ## Scope: files that PARSE, not every file
 *
 * Deliberately narrow. Asserting a substring against `verify.sh` or
 * `.gitignore` is pragmatic — there is no parser to hand and the text is the
 * artefact. The defect is asserting on text when **structure was available**:
 * `.yml`, `.yaml` and `.json` all parse trivially, and for workflows this repo
 * already ships the splitter. A blanket rule over all 81 text assertions would
 * be noise, and a guard nobody can read is one nobody reads.
 *
 * ## Why this walks the AST rather than grepping
 *
 * A grep-based version of this guard would match **its own source** — every
 * string in this file naming `toContain` would be a hit — and the estate has
 * already recorded a compliance guard firing on its own fix. Walking the AST
 * means only real call expressions count, and the strings in this comment are
 * comments.
 *
 * ## Ratchet, not a cliff
 *
 * `BASELINE` records the assertions that existed when this landed. The guard
 * fails on anything **above** baseline, never on the residue — the posture
 * `mustBeUniform` and `biffo.orphan-baseline.json` both established, because a
 * guard red on day-one residue every morning is one people learn to scroll
 * past (`scripts/protection-audit.sh` argues this at length). Fixing a file
 * below its baseline fails too, asking you to lower the number: a ratchet that
 * never tightens stops meaning anything.
 */

/** Extensions with a parser readily available, where text-matching is the bug. */
const PARSEABLE = /\.(ya?ml|json)\b/

/**
 * Substring assertions against parseable files, per test file, as of the commit
 * that added this guard. **Only ever lower these numbers.**
 *
 * Each is a real instance of the shape rather than a false positive — they
 * assert that a workflow contains some text, where the invariant is that it
 * runs a command or declares a key. They are left in place rather than
 * rewritten in this PR so the mechanism lands separately from 15 behavioural
 * edits; converting them to `assertRunsCommand` is follow-up work.
 */
const BASELINE: Record<string, number> = {
  'commands/plugin-create.test.ts': 1,
  'lib/core-tags.test.ts': 7,
  'lib/deploy-job-timeouts.test.ts': 1,
  'lib/lockfile-refresh.test.ts': 1,
  'lib/release-dispatch.test.ts': 5,
}

const cliSrc = join(dirname(fileURLToPath(import.meta.url)), '..')

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) testFiles(full, acc)
    else if (entry.name.endsWith('.test.ts')) acc.push(full)
  }
  return acc
}

/**
 * Substring assertions in one test file whose subject came from reading a
 * parseable file.
 *
 * Two passes, because the read and the assertion are usually far apart: first
 * collect every `const x = readFileSync(...)`, then find
 * `expect(x).toContain(...)` referring to one.
 */
function violations(file: string): number[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

  /** variable name -> the initialiser text it was read from */
  const readFrom = new Map<string, string>()
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const init = node.initializer.getText()
      if (init.includes('readFileSync(')) readFrom.set(node.name.text, init)
    }
    ts.forEachChild(node, collect)
  }
  collect(source)

  const lines: number[] = []
  const check = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      if (method === 'toContain' || method === 'toMatch') {
        let receiver: ts.Expression = node.expression.expression
        // `expect(x).not.toContain(...)` — step over the negation.
        if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'not') {
          receiver = receiver.expression
        }
        if (
          ts.isCallExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          receiver.expression.text === 'expect'
        ) {
          const subject = receiver.arguments[0]
          if (subject) {
            const text = subject.getText()
            const origin = ts.isIdentifier(subject)
              ? readFrom.get(subject.text)
              : text.includes('readFileSync(')
                ? text
                : undefined
            if (origin && PARSEABLE.test(origin)) {
              lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
            }
          }
        }
      }
    }
    ts.forEachChild(node, check)
  }
  check(source)
  return lines
}

describe('guards assert on structure, not on the text of a file that parses', () => {
  const found = new Map<string, number[]>()
  for (const file of testFiles(cliSrc)) {
    const lines = violations(file)
    if (lines.length) found.set(relative(cliSrc, file), lines)
  }

  it('finds the baselined instances, so the walk is not vacuously green', () => {
    // Guard the guard. A walk that resolved nothing would report zero
    // violations and pass against everything -- the fail-open this whole file
    // is about, in the file that exists to prevent it.
    expect(found.size).toBeGreaterThan(0)
  })

  it('adds no substring assertion against a .yml/.yaml/.json file', () => {
    const added: string[] = []
    for (const [file, lines] of found) {
      const allowed = BASELINE[file] ?? 0
      if (lines.length > allowed) {
        added.push(
          `${file}: ${lines.length} substring assertion(s) against a parseable file ` +
            `(baseline ${allowed}) at line(s) ${lines.join(', ')}`,
        )
      }
    }
    expect(
      added,
      'A workflow/JSON assertion must be structural, not a substring: any superset of the ' +
        'text satisfies it, so a rename by EXTENSION leaves the guard green over a file that ' +
        'no longer does the thing (#956, #718, #720). Use assertRunsCommand/assertInvokes ' +
        'from lib/workflow-run-commands.ts, or parse the file and assert on the value.',
    ).toEqual([])
  })

  it('flags a substring assertion against a workflow, and not one against a shell script', () => {
    // Pins the scope decision above so widening it is deliberate. `verify.sh`
    // has no parser to hand and its text IS the artefact; `ci.yml` parses, and
    // this repo already ships the splitter for it.
    const dir = mkdtempSync(join(tmpdir(), 'assert-scope-'))
    try {
      const write = (name: string, body: string): string => {
        const p = join(dir, name)
        writeFileSync(p, body)
        return p
      }
      const yaml = write(
        'a.test.ts',
        "const wf = readFileSync('x/ci.yml', 'utf8')\nexpect(wf).toContain('run: thing')\n",
      )
      const shell = write(
        'b.test.ts',
        "const sh = readFileSync('scripts/verify.sh', 'utf8')\nexpect(sh).toContain('run: thing')\n",
      )
      expect(violations(yaml)).toHaveLength(1)
      expect(violations(shell)).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads call expressions, not text, so it does not flag its own source', () => {
    // A grep-based version of this guard matches every mention of `toContain`
    // in its own comments and assertion messages -- and this estate has already
    // recorded a compliance guard firing on its own fix. This file names the
    // idiom many times and must stay clean.
    expect(found.has('lib/structural-assertion-guard.test.ts')).toBe(false)
  })

  it('has no baseline entry that is now too generous', () => {
    // A ratchet that never tightens stops meaning anything -- the posture
    // shared-files.json's `mustBeUniform` and biffo.orphan-baseline.json share.
    const stale: string[] = []
    for (const [file, allowed] of Object.entries(BASELINE)) {
      const actual = found.get(file)?.length ?? 0
      if (actual < allowed) {
        stale.push(`${file}: baseline ${allowed}, actual ${actual} -- lower it to ${actual}`)
      }
    }
    expect(stale, 'Fixed some? Lower the baseline in this file so it cannot regress.').toEqual([])
  })
})
