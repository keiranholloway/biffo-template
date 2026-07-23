import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { type CoreManifest, isTemplateOwned, readCoreManifest } from './core-manifest.js'

/**
 * META guard for the #367 class — the `runningInInstance` skip on repo-layout
 * assertions (issue #384).
 *
 * ## The rule this enforces
 *
 * `cli/` is carried into every instance (frozen at `biffo init`, and where an
 * instance still carries it its tests run in that instance's CI). A test under
 * `cli/` that asserts on the TEMPLATE's own repo-root layout therefore lands in
 * a repo that legitimately has a different layout, and reds the instance's CI on
 * files it never wrote and cannot repair. #367 fixed three such files; the rule
 * it set — and which nothing enforced until this guard — is:
 *
 *   > A test asserting on repo-root layout must gate on `isInstanceRepo(repoRoot)`
 *   > (skip in an instance).
 *
 * ## Why a naive "flag every repoRoot reference" guard is wrong
 *
 * Two things look identical in source — both "a path built from repoRoot":
 *   - reads the repo root (`existsSync(join(repoRoot, 'apps/foo/page.tsx'))`) —
 *     INSTANCE-INVALID, must gate; the instance's copy differs or is absent.
 *   - reads a distributed, template-owned file (`readFileSync(join(repoRoot,
 *     'core-manifest.json'))`) — INSTANCE-VALID and worth keeping live there;
 *     `biffo core upgrade` ships that file identically to every instance.
 *
 * Flagging every reference would demand the skip on ~30 correct assertions —
 * worse than the status quo. So ownership decides (issue #384 option 2): a
 * repoRoot-derived path that resolves as **template-owned** per
 * `core-manifest.json` is distributed → instance-valid → no skip needed; one that
 * does **not** is instance-invalid → MUST gate on `isInstanceRepo`. This is
 * self-maintaining: it reuses the real manifest and the real `isTemplateOwned`,
 * so it tracks ownership as the boundary moves rather than a hand-maintained list.
 *
 * ## The `released` (co-located) carve-out
 *
 * `cli/` is `released`, not `templateOwned` — `biffo core upgrade` never
 * distributes it; an instance consumes the CLI from npm and either carries a
 * frozen `cli/` from init or has dropped it. So `isTemplateOwned('cli/…')` is
 * false, yet a cli test that reads a *sibling* `cli/` path (e.g.
 * `check.test.ts` reading `cli/src/index.ts`, `core-tags.test.ts` reading
 * `cli/node_modules/.bin/tsx`) is instance-safe: the asserting test and its
 * subject are in the SAME distribution unit — present together in any repo that
 * carries `cli/`, absent together where it was dropped (there the test does not
 * run) — so it can never red an instance on a file it cannot fix. Those reads are
 * correctly ungated in the tree; the guard must not demand a skip on them. This
 * is a distribution-unit fact the template-owned/not binary doesn't name, so it
 * is added explicitly below rather than smuggled into `isTemplateOwned`.
 *
 * ## Scope — best-effort on literals (issue #384 option 2 caveat)
 *
 * The static extraction is honest about its reach. It resolves ownership only for
 * paths built as `join(repoRoot, '<literal>' …)` / `resolve(repoRoot, '<literal>'
 * …)` whose leading segment(s) are string / no-substitution-template literals.
 * OUT OF SCOPE, and NOT silently treated as covered:
 *   - paths whose relative segment is an identifier/const, a function parameter,
 *     a helper's argument, an array element, or a member expression
 *     (`join(repoRoot, CATALOG_FILE)`, `read(workflow)`, `join(repoRoot,
 *     asset.path)`) — the value isn't a literal at the call site;
 *   - template literals with a `${…}` substitution before the first complete
 *     segment;
 *   - string concatenation (`repoRoot + '/apps/foo'`).
 * A gate is recognised only as a `describe`/`it` `.skipIf(<flag>)` whose argument
 * references `isInstanceRepo` (directly or via a const bound to its result). The
 * `repoRoot` identifier itself is found by *resolving* each candidate binding to
 * an absolute path and comparing it to the real repo root, so multi-step chains
 * (`packageRoot` → `repoRoot`) and files at any depth are handled without a
 * fragile "N levels up" heuristic.
 *
 * The suite carries positive AND negative controls proving the mechanism can both
 * fire and stay silent — a guard that can only pass proves nothing (the trap a
 * previous guard in this repo fell into by matching its own prose, see
 * `template-owned-scope.test.ts`).
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const cliRoot = join(repoRoot, 'cli')

const PATH_BUILDERS = new Set(['join', 'resolve'])

interface Violation {
  file: string
  rel: string
  line: number
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return undefined
}

/** The text of a pure string/template literal, or undefined for anything else
 * (including template literals carrying a `${…}` substitution). */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node)) return node.text
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

/**
 * Resolve a directory-valued expression to an absolute path, given the source
 * file's own path and the ids resolved so far. Returns null for anything it
 * cannot statically resolve (leaving that binding untracked — under-approximate,
 * never a false positive).
 */
function resolveDir(
  node: ts.Node,
  fileName: string,
  resolved: Map<string, string>,
  sf: ts.SourceFile,
): string | null {
  if (ts.isIdentifier(node)) {
    if (node.text === '__dirname') return dirname(fileName)
    return resolved.get(node.text) ?? null
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node)
    // `dirname(fileURLToPath(import.meta.url))` (or any dirname over the module
    // URL) is the module's own directory.
    if (name === 'dirname' && /fileURLToPath|import\.meta\.url/.test(node.getText(sf))) {
      return dirname(fileName)
    }
    if (name === 'fileURLToPath' && /import\.meta\.url/.test(node.getText(sf))) {
      return fileName
    }
    if (name === 'join' || name === 'resolve') {
      const base = node.arguments[0] ? resolveDir(node.arguments[0], fileName, resolved, sf) : null
      if (base === null) return null
      const segs: string[] = []
      for (let i = 1; i < node.arguments.length; i++) {
        const lit = literalText(node.arguments[i])
        if (lit === undefined) return null
        segs.push(lit)
      }
      // base is absolute and segments are relative ascents, so join and resolve
      // agree; resolve normalises the `..` sequence.
      return resolve(base, ...segs)
    }
  }
  return null
}

/** Leading run of literal path segments after the root arg, as a posix relative
 * path — or null when the first segment isn't a literal. */
function leadingLiteralPath(args: readonly ts.Node[]): string | null {
  const segs: string[] = []
  for (const a of args) {
    const lit = literalText(a)
    if (lit === undefined) break
    segs.push(lit)
  }
  if (segs.length === 0) return null
  return segs.join('/').replace(/\/{2,}/g, '/')
}

/** Instance-safe: distributed identically to instances (template-owned), or a
 * sibling in the test's own `released` distribution unit (see the header). */
function isInstanceSafe(rel: string, manifest: CoreManifest): boolean {
  if (isTemplateOwned(rel, manifest)) return true
  return manifest.released.some((p) =>
    p.endsWith('/') ? rel === p.slice(0, -1) || rel.startsWith(p) : rel === p,
  )
}

/**
 * Is `node` lexically inside a `describe`/`it` whose `.skipIf(<flag>)` gates on
 * the instance probe? Walks ancestors: a match at any level counts, and reaching
 * the top ungated correctly treats module-scope reads as ungated too (a
 * `.skipIf` cannot guard code that runs at import time).
 */
function isGated(node: ts.Node, instanceFlags: Set<string>, sf: ts.SourceFile): boolean {
  let cur: ts.Node = node
  while (cur.parent) {
    const parent = cur.parent
    if (ts.isCallExpression(parent) && (parent.arguments as readonly ts.Node[]).includes(cur)) {
      const callee = parent.expression
      if (
        ts.isCallExpression(callee) &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === 'skipIf'
      ) {
        const argText = callee.arguments.map((a) => a.getText(sf)).join(',')
        if (
          /\bisInstanceRepo\b/.test(argText) ||
          [...instanceFlags].some((id) => new RegExp(`\\b${id}\\b`).test(argText))
        ) {
          return true
        }
      }
    }
    cur = parent
  }
  return false
}

/**
 * Scan one test source for repoRoot-derived literal-path reads that resolve as
 * instance-invalid yet are not gated on `isInstanceRepo`. Pure over its inputs so
 * the controls can drive it with synthetic sources.
 *
 * `fileName` must be the file's real (or a representative) absolute path — the
 * repo-root binding is identified by resolving it and comparing to `repoRootAbs`.
 */
function scanSource(
  fileName: string,
  source: string,
  manifest: CoreManifest,
  repoRootAbs: string,
): Violation[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  // Resolve every `const … = <dir expr>` in source order, then pick out the ids
  // that resolve to the repo root and the ids bound to `isInstanceRepo(…)`.
  const resolved = new Map<string, string>()
  const rootIds = new Set<string>()
  const instanceFlags = new Set<string>()

  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const abs = resolveDir(node.initializer, fileName, resolved, sf)
      if (abs !== null) {
        resolved.set(node.name.text, abs)
        if (resolve(abs) === resolve(repoRootAbs)) rootIds.add(node.name.text)
      }
      if (
        ts.isCallExpression(node.initializer) &&
        calleeName(node.initializer) === 'isInstanceRepo'
      ) {
        instanceFlags.add(node.name.text)
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(sf)

  const violations: Violation[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      const first = node.arguments[0]
      if (
        name &&
        PATH_BUILDERS.has(name) &&
        first &&
        ts.isIdentifier(first) &&
        rootIds.has(first.text)
      ) {
        const rel = leadingLiteralPath(node.arguments.slice(1))
        if (rel && !isInstanceSafe(rel, manifest) && !isGated(node, instanceFlags, sf)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
          violations.push({ file: fileName, rel, line: line + 1 })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return violations
}

function findTestFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.turbo') continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findTestFiles(abs))
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(abs)
  }
  return out
}

describe('META: repo-layout assertions must gate on the runningInInstance skip (#384)', () => {
  const manifest = readCoreManifest(repoRoot)

  it('every cli test file is clean under the guard', () => {
    const files = findTestFiles(cliRoot)
    // A scanner that finds nothing would pass vacuously and hide a broken walk.
    expect(files.length).toBeGreaterThan(0)

    const violations = files.flatMap((file) =>
      scanSource(file, readFileSync(file, 'utf8'), manifest, repoRoot),
    )

    // A readable failure: each offender names the file, the instance-invalid
    // path it asserts on, and the fix.
    const report = violations
      .map(
        (v) =>
          `  ${v.file.slice(repoRoot.length + 1)}:${v.line} asserts on non-distributed path ` +
          `'${v.rel}' without an isInstanceRepo() skip`,
      )
      .join('\n')
    expect(
      violations,
      violations.length === 0
        ? ''
        : `Repo-layout assertions that would red an instance's CI on files it cannot fix.\n` +
            `Gate each on isInstanceRepo(repoRoot) (skip in an instance) — see #367/#384:\n${report}`,
    ).toEqual([])
  })

  // A representative file path at this file's depth, so `join(__dirname, '..',
  // '..', '..')` in a snippet resolves to the real repo root.
  const asFile = join(repoRoot, 'cli', 'src', 'lib', '_synthetic.test.ts')
  const manifestFor = readCoreManifest(repoRoot)

  const HEADER = [
    `import { existsSync, readFileSync } from 'node:fs'`,
    `import { join } from 'node:path'`,
    `import { isInstanceRepo } from './core-version.js'`,
    `const repoRoot = join(__dirname, '..', '..', '..')`,
  ].join('\n')

  it('negative control: FLAGS an ungated read of an instance-invalid path', () => {
    const src = `${HEADER}
      it('x', () => {
        expect(existsSync(join(repoRoot, 'apps/my-product/page.tsx'))).toBe(false)
      })`
    const v = scanSource(asFile, src, manifestFor, repoRoot)
    expect(v).toHaveLength(1)
    expect(v[0]?.rel).toBe('apps/my-product/page.tsx')
  })

  it('positive control: a `skipIf(isInstanceRepo)` gate silences the same read', () => {
    const src = `${HEADER}
      const runningInInstance = isInstanceRepo(repoRoot)
      it.skipIf(runningInInstance)('x', () => {
        expect(existsSync(join(repoRoot, 'apps/my-product/page.tsx'))).toBe(false)
      })`
    expect(scanSource(asFile, src, manifestFor, repoRoot)).toEqual([])
  })

  it('does not flag a template-owned (distributed) path — no skip required', () => {
    const src = `${HEADER}
      it('x', () => {
        readFileSync(join(repoRoot, 'core-manifest.json'), 'utf8')
        existsSync(join(repoRoot, 'apps/portal/src/app/page.tsx'))
      })`
    expect(scanSource(asFile, src, manifestFor, repoRoot)).toEqual([])
  })

  it('does not flag a released, co-located cli/ sibling path — no skip required', () => {
    const src = `${HEADER}
      it('x', () => {
        readFileSync(join(repoRoot, 'cli/src/index.ts'), 'utf8')
      })`
    expect(scanSource(asFile, src, manifestFor, repoRoot)).toEqual([])
  })

  it('leaves non-literal (dynamically built) paths out of scope, not silently passed', () => {
    // The relative segment is an identifier, not a literal at the call site — the
    // guard cannot resolve its ownership and does not pretend to. Documented in
    // the header as a known limitation, asserted here so the boundary is explicit.
    const src = `${HEADER}
      const SOME_PATH = 'apps/my-product/page.tsx'
      it('x', () => {
        existsSync(join(repoRoot, SOME_PATH))
      })`
    expect(scanSource(asFile, src, manifestFor, repoRoot)).toEqual([])
  })
})
