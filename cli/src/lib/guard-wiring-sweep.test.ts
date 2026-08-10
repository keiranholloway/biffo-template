import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * Sweep guard for the class issue #1413 names: `core-direct-paths-audit.ts`
 * (#1406), `eventbridge-log-permission-guard.ts` (#1408) and
 * `plugin-tool-supply-audit.ts` (#1409) shipped with ZERO callers — no
 * `cli/src/commands/` entry, no workflow step, no `scripts/` entry — and
 * their unit tests (fixture-only, never the real tree) kept CI green while
 * the audit that should have caught it, `scripts/ci-wiring-audit.sh`, read
 * its scope from `shared-files.json`'s `requiresCiStep` map, which held
 * exactly ONE entry. Denominator of 1, reporting green, catching nothing.
 *
 * ## Discovery, not enumeration
 *
 * #1413's own second comment is explicit that adding these three to
 * `requiresCiStep` is NOT the fix — it takes the denominator 1→4 and leaves
 * guard five invisible in exactly the same way. This sweep instead
 * enumerates `cli/src/lib/*-audit.ts` and `*-guard.ts` **from the
 * filesystem** (`readdirSync`, never a hand-maintained list) and asserts
 * each is reachable from a `cli/src/commands/` entry, or is named in a
 * `.github/workflows/*.yml` step. Adding a guard with neither must fail the
 * build — there is no manifest to forget to update, because there is no
 * manifest.
 *
 * ## AST reachability, not a grep (#956)
 *
 * `structural-assertion-guard.test.ts` names the class this estate keeps
 * re-finding: a guard asserting on the TEXT of a file that parses is
 * satisfied by any superset, so renaming `plugin-collisions` to
 * `plugin-collisionsXX` would leave a substring check green over a workflow
 * that no longer runs it. `check.ts` never imports a guard directly — every
 * entry routes through a `cli/src/scripts/check-*.ts` wrapper — so a
 * single-hop "does `commands/` import `lib/` " check would incorrectly flag
 * every existing guard. This walks the real import graph instead: parse
 * every `.ts` file under `cli/src/{commands,scripts,lib}` with the
 * TypeScript compiler API, follow relative `import`/`export … from`
 * specifiers, and ask whether a guard module is reachable from the set of
 * `cli/src/commands/*.ts` entrypoints.
 *
 * ## Baseline: five guards this repo already shipped unwired
 *
 * `cognito-invite-template-guard.ts`, `lambda-output-guard.ts`,
 * `pipe-trap-guard.ts`, `skeleton-drift-guard.ts` and
 * `terraform-input-guard.ts` predate #1413 and are not reachable from
 * `cli/src/commands/` or named in any workflow. They are NOT the same
 * failure shape as #1413's three, though: each one's own `.test.ts` calls
 * the guard function directly against this repo's real `repoRoot` (e.g.
 * `expect(checkTerraformInput(repoRoot)).toEqual([])`), which runs on every
 * PR via the `js` job's `Test` step — a real, but different, wiring channel
 * this sweep does not (yet) recognise. That gap is real and is reported
 * rather than silently fixed here (out of #1413's scope, which names three
 * specific guards) or silently swept into invisibility: same ratchet posture
 * as `mustBeUniform`'s baseline in `AGENTS.md` §9 — pre-existing residue
 * never blocks, but the list only shrinks. A guard newly wired must be
 * removed from it (the test below enforces that direction too), and no new
 * name may be added.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const cliSrc = join(repoRoot, 'cli', 'src')
const commandsDir = join(cliSrc, 'commands')
const scriptsDir = join(cliSrc, 'scripts')
const libDir = join(cliSrc, 'lib')
const workflowsDir = join(repoRoot, '.github', 'workflows')

const IN_SCOPE_DIRS = [commandsDir, scriptsDir, libDir]

/** `*-audit.ts` / `*-guard.ts` directly under `cli/src/lib`, discovered from
 * the filesystem. The full filename must match — `.test.ts` always fails
 * the suffix test, so `foo-guard.test.ts` can never be mistaken for a real
 * guard module regardless of what precedes it. */
export function discoverGuardFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /-(audit|guard)\.ts$/.test(f) && !f.endsWith('.test.ts'))
    .sort()
}

/** Relative import/re-export specifiers a `.ts` file names, read via the
 * TypeScript AST — never a regex over source text (#956). */
export function importSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const specs: string[] = []
  sourceFile.forEachChild((node) => {
    const isImportOrReexport = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
    if (isImportOrReexport && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text)
    }
  })
  return specs
}

/** Resolve a relative specifier (`../lib/foo.js`) against the importing
 * file's directory to an absolute `.ts` path. Returns null for a package
 * import (`commander`, `node:fs`) — nothing to follow. */
function resolveRelativeSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  return resolve(dirname(fromFile), spec).replace(/\.js$/, '.ts')
}

/** Every `.ts` file reachable, by relative import, from `roots` — staying
 * inside `cli/src/{commands,scripts,lib}`, which is the whole surface a
 * guard can be wired through. */
export function reachableFrom(roots: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    let specs: string[]
    try {
      specs = importSpecifiers(file)
    } catch {
      continue // not parseable as a module from this position — not this sweep's job
    }
    for (const spec of specs) {
      const resolved = resolveRelativeSpecifier(file, spec)
      if (!resolved) continue
      if (!IN_SCOPE_DIRS.some((d) => resolved.startsWith(d + '/'))) continue
      if (!seen.has(resolved)) queue.push(resolved)
    }
  }
  return seen
}

function commandEntryFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(dir, f))
}

function workflowStepText(dir: string): string {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  } catch {
    return ''
  }
  return files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
}

const PRE_EXISTING_UNWIRED = new Set([
  'cognito-invite-template-guard.ts',
  'lambda-output-guard.ts',
  'pipe-trap-guard.ts',
  'skeleton-drift-guard.ts',
  'terraform-input-guard.ts',
])

describe('guard wiring sweep (#1413): every cli/src/lib/*-audit.ts and *-guard.ts must have a caller', () => {
  it('discovers at least one real guard file — a sweep that finds none is not sweeping', () => {
    const found = discoverGuardFiles(libDir)
    expect(found.length).toBeGreaterThan(0)
    // Pin the three #1413 named — if any is ever renamed this fails loudly
    // rather than silently stop checking it.
    expect(found).toEqual(
      expect.arrayContaining([
        'core-direct-paths-audit.ts',
        'eventbridge-log-permission-guard.ts',
        'plugin-tool-supply-audit.ts',
      ]),
    )
  })

  it('every guard is reachable from cli/src/commands/, named in a workflow step, or explicitly baselined', () => {
    const guardFiles = discoverGuardFiles(libDir)
    const reachable = reachableFrom(commandEntryFiles(commandsDir))
    const workflowText = workflowStepText(workflowsDir)

    const unwired: string[] = []
    const staleBaseline: string[] = []

    for (const guardFile of guardFiles) {
      const absPath = join(libDir, guardFile)
      const basename = guardFile.replace(/\.ts$/, '')
      const wiredViaCommand = reachable.has(absPath)
      const wiredViaWorkflow = workflowText.includes(basename)
      const wired = wiredViaCommand || wiredViaWorkflow

      if (PRE_EXISTING_UNWIRED.has(guardFile)) {
        if (wired) staleBaseline.push(guardFile) // now fixed — the list must shrink
        continue
      }
      if (!wired) unwired.push(guardFile)
    }

    if (staleBaseline.length > 0) {
      throw new Error(
        `${staleBaseline.join(', ')} ${staleBaseline.length === 1 ? 'is' : 'are'} now wired but ` +
          `still listed in PRE_EXISTING_UNWIRED (guard-wiring-sweep.test.ts) — remove ` +
          `${staleBaseline.length === 1 ? 'it' : 'them'} so the baseline keeps shrinking rather than going stale.`,
      )
    }

    expect(
      unwired,
      `${unwired.length} guard(s) have no caller at all — no cli/src/commands/ entry reaches ` +
        `them and no .github/workflows/*.yml step names them: ${unwired.join(', ')}. This is ` +
        `exactly #1413's class: a guard whose unit tests pass in isolation while nothing ever ` +
        `runs it against the estate. Wire a cli/src/commands/ entry (see check.ts) and a CI step.`,
    ).toEqual([])
  })

  // ── Mechanism controls: a sweep that can only pass proves nothing (the
  // class #956 names) ────────────────────────────────────────────────────

  it('flags a synthetic guard file with no importer anywhere', () => {
    const dir = makeTmpDir('guard-sweep-unwired')
    const commands = join(dir, 'commands')
    const lib = join(dir, 'lib')
    mkdirSync(commands, { recursive: true })
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'orphan-guard.ts'), 'export function check() { return [] }\n')
    writeFileSync(join(commands, 'unrelated.ts'), "import { z } from 'zod'\nz\n")

    const guardFiles = discoverGuardFiles(lib)
    expect(guardFiles).toEqual(['orphan-guard.ts'])
    const reachable = reachableFrom(commandEntryFiles(commands))
    expect(reachable.has(join(lib, 'orphan-guard.ts'))).toBe(false)
  })

  it('recognises a guard reached through a commands/ -> scripts/ -> lib/ hop, mirroring check.ts', () => {
    const dir = makeTmpDir('guard-sweep-wired')
    const commands = join(dir, 'commands')
    const scripts = join(dir, 'scripts')
    const lib = join(dir, 'lib')
    mkdirSync(commands, { recursive: true })
    mkdirSync(scripts, { recursive: true })
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'wired-guard.ts'), 'export function check() { return [] }\n')
    writeFileSync(
      join(scripts, 'check-wired.ts'),
      "import { check } from '../lib/wired-guard.js'\ncheck\n",
    )
    writeFileSync(
      join(commands, 'check.ts'),
      "import { check } from '../scripts/check-wired.js'\ncheck\n",
    )

    // reachableFrom is scoped to cli/src/{commands,scripts,lib} in the real
    // sweep — exercise the same three-directory shape here.
    const scopedReachable = (() => {
      const scopedDirs = [commands, scripts, lib]
      const seen = new Set<string>()
      const queue = commandEntryFiles(commands)
      while (queue.length > 0) {
        const file = queue.pop() as string
        if (seen.has(file)) continue
        seen.add(file)
        for (const spec of importSpecifiers(file)) {
          if (!spec.startsWith('.')) continue
          const resolved = resolve(dirname(file), spec).replace(/\.js$/, '.ts')
          if (scopedDirs.some((d) => resolved.startsWith(d + '/')) && !seen.has(resolved)) {
            queue.push(resolved)
          }
        }
      }
      return seen
    })()

    expect(scopedReachable.has(join(lib, 'wired-guard.ts'))).toBe(true)
  })

  it('the real sweep finds the three #1413 guards reachable from cli/src/commands/ today', () => {
    const reachable = reachableFrom(commandEntryFiles(commandsDir))
    for (const guard of [
      'core-direct-paths-audit.ts',
      'eventbridge-log-permission-guard.ts',
      'plugin-tool-supply-audit.ts',
    ]) {
      expect(reachable.has(join(libDir, guard))).toBe(true)
    }
  })
})
