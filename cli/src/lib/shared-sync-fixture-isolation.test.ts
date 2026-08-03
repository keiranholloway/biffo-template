import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * No test may execute `scripts/shared-sync.sh` **out of this repository's own
 * checkout**.
 *
 * `shared-sync.sh` derives `TEMPLATE_ROOT` from `dirname $0/..`, so running the
 * copy that sits in this repo makes the tree the test is running in the
 * template under test — including its git state. Since #1234 that state is
 * itself checked: on branch `dev`, a checkout behind `origin/dev` exits 2
 * before anything else runs.
 *
 * Three tests therefore passed or failed on how recently the developer had run
 * `git pull`, with byte-identical code either side (#1252). They observed the
 * staleness message rather than the fetch-failure and worktree-log output they
 * assert on. Worse than a flake: it reads as a red integration branch, which
 * AGENTS.md section 6 makes everyone's next task — and CI can never reproduce
 * it, because CI checks out a detached merge ref where the preflight does not
 * apply. The failure lands only on whoever has not pulled.
 *
 * The fix is a fixture template the test owns (`test-utils/
 * shared-sync-template.ts`), and this guard is what keeps it. Deliberately NOT
 * an env-var bypass in the script: an escape hatch on a fail-closed guard is
 * reachable by anyone the guard is inconvenient for, and this particular guard
 * exists because being behind produces a confident wrong ANSWER rather than an
 * error.
 *
 * AST, not grep, for the same reason `no-raw-mkdtemp.test.ts` is: this file
 * names the path it forbids many times in prose, and a substring check would
 * fire on its own source.
 *
 * ## What is allowed, and why
 *
 * **Reading** the real script is fine and several tests must: `ship-guard`
 * lifts a shell function out of it by line range, `rehearsal` copies it into a
 * fixture, and `worktree-log` asserts on its source text. None of that sets
 * `TEMPLATE_ROOT`. Only handing the repo's own copy to a child process does.
 */
const cliSrc = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The child-process entry points that would actually run the script. */
const EXEC_CALLS = new Set(['exec', 'execFile', 'execFileSync', 'execSync', 'spawn', 'spawnSync'])

/** Names imported from the shared fixture helper that ARE a repo-root script
 * path, so a test cannot launder one through the helper. */
const IMPORTED_SCRIPT_PATHS = new Set(['realSharedSync'])

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return undefined
}

const ROOT_MARKER = /import\.meta\.(dirname|url)/

/** Lines (1-based) where `file` executes a path derived from this repo's own
 * location and naming `shared-sync.sh`. */
export function repoRootScriptExecutions(file: string, text: string): number[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)

  // Functions whose body resolves this repo's root — `repoRoot()` walking up
  // from `import.meta.url` is the shape rehearsal uses.
  const rootFns = new Set<string>()
  // Identifiers holding a path inside this repository.
  const rootIds = new Set<string>()
  // Identifiers holding this repo's own copy of the script: the thing that
  // must never be executed.
  const scriptIds = new Set<string>(IMPORTED_SCRIPT_PATHS)

  const collect = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      if (ROOT_MARKER.test(node.body.getText())) rootFns.add(node.name.text)
    }
    ts.forEachChild(node, collect)
  }
  collect(source)

  // Two passes, so a declaration that references an identifier declared later
  // in the file is still resolved.
  for (let pass = 0; pass < 2; pass += 1) {
    const declare = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = node.initializer.getText()
        const fromRoot =
          ROOT_MARKER.test(init) ||
          [...rootFns].some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(init)) ||
          [...rootIds].some((id) => new RegExp(`\\b${id}\\b`).test(init))
        if (fromRoot) {
          rootIds.add(node.name.text)
          if (/shared-sync\.sh/.test(init)) scriptIds.add(node.name.text)
        }
      }
      ts.forEachChild(node, declare)
    }
    declare(source)
  }

  const lines: number[] = []
  const check = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && EXEC_CALLS.has(calleeName(node.expression) ?? '')) {
      const offends = node.arguments.some((arg) => {
        let hit = false
        const walk = (n: ts.Node): void => {
          if (ts.isIdentifier(n) && scriptIds.has(n.text)) hit = true
          ts.forEachChild(n, walk)
        }
        walk(arg)
        // Also the inline form, with no intermediate variable to name.
        const argText = arg.getText()
        if (/shared-sync\.sh/.test(argText) && [...rootIds].some((id) => argText.includes(id))) {
          hit = true
        }
        return hit
      })
      if (offends) lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    }
    ts.forEachChild(node, check)
  }
  check(source)
  return lines
}

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) testFiles(full, acc)
    else if (entry.name.endsWith('.test.ts')) acc.push(full)
  }
  return acc
}

describe('no test runs shared-sync.sh from this repo checkout', () => {
  const files = testFiles(cliSrc)
  const found = new Map<string, number[]>()
  for (const file of files) {
    const lines = repoRootScriptExecutions(file, readFileSync(file, 'utf8'))
    if (lines.length) found.set(relative(cliSrc, file), lines)
  }

  it('walks the shared-sync tests, so the sweep is not vacuously green', () => {
    // Guard the guard. A walk that resolved nothing would report zero
    // violations and pass against everything — the exact defect class this
    // repo keeps finding (a check that skips what it cannot see).
    expect(files.length).toBeGreaterThan(50)
    const sharedSync = files.filter((f) => f.includes('shared-sync'))
    expect(sharedSync.length).toBeGreaterThanOrEqual(6)
  })

  it('every test that drives the script does so from a fixture template', () => {
    const violations = [...found].map(([file, lines]) => `${file}: line(s) ${lines.join(', ')}`)
    expect(
      violations,
      'Build a template the test owns — makeTemplateCheckout() from test-utils/' +
        'shared-sync-template.ts — and execute the copy inside it. Running this ' +
        "repo's own scripts/shared-sync.sh makes TEMPLATE_ROOT the developer's " +
        'checkout, so the staleness preflight decides the test (#1252).',
    ).toEqual([])
  })

  it('flags the shape that caused #1252 and clears the fixture shape', () => {
    // Pinned against minimal sources, so the detector is proven independently
    // of whatever the real tree currently holds.
    const offending = [
      "const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'shared-sync.sh')",
      "execFileSync('bash', [script, '--estate', estate])",
    ].join('\n')
    const inline = [
      'const root = dirname(fileURLToPath(import.meta.url))',
      "spawnSync('sh', [join(root, 'scripts/shared-sync.sh'), '--check'])",
    ].join('\n')
    const fixture = [
      'const script = sharedSyncIn(makeTemplateCheckout(root))',
      "execFileSync('bash', [script, '--estate', estate])",
    ].join('\n')
    const readingIsFine = [
      "const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'shared-sync.sh')",
      "const body = readFileSync(script, 'utf8')",
      "execFileSync('bash', ['-c', extractedFunction(body)])",
    ].join('\n')

    expect(repoRootScriptExecutions('a.test.ts', offending)).toEqual([2])
    expect(repoRootScriptExecutions('b.test.ts', inline)).toEqual([2])
    expect(repoRootScriptExecutions('c.test.ts', fixture)).toEqual([])
    expect(repoRootScriptExecutions('d.test.ts', readingIsFine)).toEqual([])
  })

  it('does not flag its own source, which names the path many times in prose', () => {
    expect(found.has('lib/shared-sync-fixture-isolation.test.ts')).toBe(false)
  })
})
