import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * `mkdtempSync(join(tmpdir(), '<prefix>-'))` called directly from a test file
 * leaks a directory into `/tmp` unless that specific test remembers its own
 * cleanup. 171+ sites across 71 files did exactly that (#1197) — `/tmp` is a
 * 16 GB tmpfs recreated at boot, and it filled with tens of thousands of
 * fixture directories in days.
 *
 * `makeTmpDir` (`test-utils/tmp.ts`) is the fix: every directory it creates
 * is swept automatically once a test file's suite finishes, so callers never
 * need to remember cleanup. This guard is what makes that durable — it walks
 * the AST of every `*.test.ts` file and fails if `mkdtempSync` is called
 * anywhere except inside `test-utils/tmp.ts` itself. AST, not grep or a
 * substring check, so the guard does not fire on its own source (this file's
 * doc comment and string literals both say `mkdtempSync` many times) and does
 * not need updating for reformatted call sites.
 *
 * No ratchet/baseline here, unlike `structural-assertion-guard.test.ts`: the
 * fix converted every existing call site, so the correct baseline is zero and
 * any future direct call is a regression, not pre-existing debt.
 *
 * Deliberately scoped to `cli/src/**\/*.test.ts` — production call sites
 * (`lib/core-upgrade.ts`, `lib/core-template-trees.ts`, `adapters/git/
 * index.ts`, `commands/sibling-create.ts`) create a working directory for a
 * real upgrade/clone/scaffold operation on a user's machine, not a test
 * fixture, and are out of scope for this guard.
 */
const cliSrc = join(dirname(fileURLToPath(import.meta.url)), '..')

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) testFiles(full, acc)
    else if (entry.name.endsWith('.test.ts')) acc.push(full)
  }
  return acc
}

/** Line numbers (1-based) of any direct `mkdtempSync(...)` call in `file`,
 * whether called bare (`mkdtempSync(...)`) or via a property access
 * (`fs.mkdtempSync(...)`). */
function rawMkdtempCalls(file: string): number[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const lines: number[] = []

  const calleeName = (expr: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expr)) return expr.text
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text
    return undefined
  }

  const check = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node.expression) === 'mkdtempSync') {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    }
    ts.forEachChild(node, check)
  }
  check(source)
  return lines
}

describe('no test file calls mkdtempSync directly', () => {
  const found = new Map<string, number[]>()
  for (const file of testFiles(cliSrc)) {
    const lines = rawMkdtempCalls(file)
    if (lines.length) found.set(relative(cliSrc, file), lines)
  }

  it('walks at least one real file, so the walk is not vacuously green', () => {
    // Guard the guard: an empty testFiles() result or a parser that resolves
    // nothing would report zero violations and pass against everything.
    expect(testFiles(cliSrc).length).toBeGreaterThan(50)
  })

  it('every temp directory in a test file goes through makeTmpDir', () => {
    const violations: string[] = []
    for (const [file, lines] of found) {
      violations.push(`${file}: direct mkdtempSync at line(s) ${lines.join(', ')}`)
    }
    expect(
      violations,
      'Use makeTmpDir(prefix) from test-utils/tmp.ts instead of calling mkdtempSync ' +
        'directly — it registers automatic cleanup so the directory cannot leak into ' +
        '/tmp (#1197). If this file IS test-utils/tmp.ts, this guard has a bug.',
    ).toEqual([])
  })

  it('flags a direct call and does not flag one routed through makeTmpDir', () => {
    // Pins the detection itself against a minimal fixture in each shape,
    // independent of anything currently in the real tree.
    const raw = ts.createSourceFile(
      'fixture.test.ts',
      "import { mkdtempSync } from 'node:fs'\nconst d = mkdtempSync(x)\n",
      ts.ScriptTarget.Latest,
      true,
    )
    const viaHelper = ts.createSourceFile(
      'fixture.test.ts',
      "import { makeTmpDir } from '../test-utils/tmp.js'\nconst d = makeTmpDir('x')\n",
      ts.ScriptTarget.Latest,
      true,
    )
    const linesFor = (source: ts.SourceFile): number[] => {
      const lines: number[] = []
      const calleeName = (expr: ts.Expression): string | undefined => {
        if (ts.isIdentifier(expr)) return expr.text
        if (ts.isPropertyAccessExpression(expr)) return expr.name.text
        return undefined
      }
      const check = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && calleeName(node.expression) === 'mkdtempSync') {
          lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
        }
        ts.forEachChild(node, check)
      }
      check(source)
      return lines
    }
    expect(linesFor(raw)).toEqual([2])
    expect(linesFor(viaHelper)).toEqual([])
  })

  it('does not flag its own source, which names mkdtempSync many times in prose', () => {
    expect(found.has('test-utils/no-raw-mkdtemp.test.ts')).toBe(false)
  })
})
