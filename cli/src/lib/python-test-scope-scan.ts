import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { isTemplateOwned, readCoreManifest } from './core-manifest.js'

/**
 * Extends the #325/#327 META guard (`template-owned-scope.test.ts`) into
 * `services/api/tests/` and its siblings — Python test files were entirely
 * outside the three existing raw-tree scanners' reach (#1454, filed as the
 * corrected diagnosis for #1452's `test_plugin_storage_prefix_grant.py`
 * asserting over a path `core-manifest.json` did not then list).
 *
 * The mechanism: pytest files that resolve a repo root via
 * `Path(__file__).resolve().parents[N]` and build a path from it with `/`
 * segments — `_TF = _REPO_ROOT / "infra" / "environments" / "dev" /
 * "plugin-storage.core.tf"` is the shape #1452 shipped. It is not a literal
 * string, so a text search for a path never finds it; this walks each
 * qualifying test file's source and tracks that chain instead.
 *
 * Deliberately not a real Python AST parser — the codebase has none, and the
 * shape in use across every existing instance (9 files, enumerated in #1454)
 * is narrow enough that a line-oriented regex walk covers it. What it does
 * NOT handle, stated rather than silently missed:
 *   - a `parents[N]` chain split across multiple lines (e.g. inside a
 *     parenthesised continuation)
 *   - a path built through an f-string, `os.path.join`, or string
 *     concatenation rather than `Path.__truediv__`
 *   - a root variable reassigned to something unrelated partway through a
 *     file (tracked as one map per file, not per scope)
 * A false negative here reads as "nothing reached", which is exactly the
 * failure this scanner exists to close — so the coverage count this guard's
 * own test prints is the check that the walk is actually running, not just
 * compiling.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', '.venv', '__pycache__', 'dist'])

const ROOT_CALL = /Path\(__file__\)\.resolve\(\)\.parents\[(\d+)\]/

/** All `"segment"` (or `'segment'`) literals in a `/`-chain, in order. */
function extractSegments(chain: string): string[] {
  const segments: string[] = []
  const re = /["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(chain)) !== null) {
    const seg = m[1]
    if (seg !== undefined) segments.push(seg)
  }
  return segments
}

function joinRel(base: string, segments: string[]): string {
  return [base, ...segments].filter((s) => s.length > 0).join('/')
}

/**
 * `Path(__file__).resolve().parents[N]` is relative to where the FILE lives,
 * not to the repo root — `parents[3]` from `services/api/tests/x.py` is the
 * repo root (tests -> api -> services -> root), but the same `parents[3]`
 * from a file three directories deeper (e.g. a skeleton's own copy nested
 * under `_skeletons/sibling-template/services/api/tests/x.py`) is that
 * skeleton's own root, not this repo's. Getting this wrong produced two real
 * false positives during development: `parents[1]` chains resolving to a
 * bare `"src/api"` instead of `"services/api/src/api"`, and a skeleton
 * fixture's `apps/frontend/src` reading as an unowned top-level path instead
 * of the (wholly template-owned) `_skeletons/sibling-template/apps/frontend/src`.
 *
 * `fileDir` is the repo-relative directory the test file itself lives in
 * (POSIX segments, no trailing slash). `parents[N]` removes the last N of
 * those segments.
 */
function resolveParentsBase(fileDir: string, n: number): string {
  const segments = fileDir ? fileDir.split('/') : []
  const kept = segments.slice(0, Math.max(0, segments.length - n))
  return kept.join('/')
}

/**
 * Every repo-root-relative path a Python test in a template-owned test tree
 * resolves via `Path(__file__).resolve().parents[N]` and a `/` chain,
 * whether assigned to a variable, chained through one, or used inline.
 *
 * `fileDir` must be the POSIX repo-relative directory containing the source
 * (see `resolveParentsBase`) — pass `''` to treat `parents[N]` as if the file
 * sat at the repo root (only correct for a file that actually does).
 */
export function extractPythonTestAssertedPaths(source: string, fileDir = ''): string[] {
  const lines = source.split('\n')
  const varPaths = new Map<string, string>() // varName -> repo-relative path ('' = root)
  const reached: string[] = []
  const chainAfter = /((?:\s*\/\s*["'][^"']+["'])+)/

  for (const line of lines) {
    // 1. NAME = Path(__file__).resolve().parents[N] [ / "seg" ]*
    const rootMatch = new RegExp(
      `(\\w+)\\s*=\\s*${ROOT_CALL.source}\\s*${chainAfter.source}?`,
    ).exec(line)
    if (rootMatch) {
      const varName = rootMatch[1] as string
      const n = Number(rootMatch[2])
      const base = resolveParentsBase(fileDir, n)
      const segs = extractSegments(rootMatch[3] ?? '')
      const relPath = joinRel(base, segs)
      varPaths.set(varName, relPath)
      if (relPath) reached.push(relPath)
      continue
    }

    // 2. NAME = <knownVar> / "seg" [/ "seg"]*  (with or without a leading '(')
    const varAssign = /(\w+)\s*=\s*\(?\s*(\w+)\s*((?:\s*\/\s*["'][^"']+["'])+)/.exec(line)
    if (varAssign) {
      const [, newVar, baseVar, chainRaw] = varAssign as unknown as [string, string, string, string]
      const base = varPaths.get(baseVar)
      if (base !== undefined) {
        const relPath = joinRel(base, extractSegments(chainRaw))
        varPaths.set(newVar, relPath)
        reached.push(relPath)
        continue
      }
    }

    // 3. Inline use of a known var chained further, anywhere in the line —
    // e.g. `(_REPO_ROOT / "biffo.core.json").is_file()`, or a chain passed
    // straight into a call without ever being assigned to its own name.
    for (const [varName, base] of varPaths) {
      const re = new RegExp(`\\b${varName}\\b\\s*((?:\\s*\\/\\s*["'][^"']+["'])+)`)
      const m = re.exec(line)
      if (m) {
        const relPath = joinRel(base, extractSegments(m[1] as string))
        reached.push(relPath)
      }
    }
  }

  return reached
}

/**
 * Walks every Python test file that is itself template-owned (self-filtered
 * through `isTemplateOwned`, the same pattern `plugin-terraform-guard`'s
 * `findPluginManifests` uses for its instance case — `services/api/tests/
 * instance/` is explicitly `userOwned` in `core-manifest.json` and must not
 * be reached) and returns every repo-relative path such a file resolves via
 * the `parents[N]` chain above.
 *
 * A scanner that runs and finds nothing looks identical to one that runs and
 * finds no problems (#1454's own stated risk) — callers should assert the
 * return value is non-empty, the same vacuity check the other three raw-tree
 * scanners already carry in `template-owned-scope.test.ts`.
 */
export function findPythonTestAssertedPaths(root: string): string[] {
  const manifest = readCoreManifest(root)
  const reached: string[] = []

  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
      } else if (entry.isFile() && /^test_.*\.py$/.test(entry.name)) {
        const abs = join(dir, entry.name)
        const rel = relative(root, abs).split(sep).join('/')
        if (!isTemplateOwned(rel, manifest)) continue
        const fileDir = rel.split('/').slice(0, -1).join('/')
        const source = readFileSync(abs, 'utf8')
        reached.push(...extractPythonTestAssertedPaths(source, fileDir))
      }
    }
  }

  walk(root)
  return [...new Set(reached)].sort()
}
