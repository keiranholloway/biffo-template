import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractPythonTestAssertedPaths,
  findPythonTestAssertedPaths,
} from './python-test-scope-scan.js'

const repoRoot = join(__dirname, '..', '..', '..')

// services/api/tests/ -> 3 segments up to the repo root, matching the real
// shape (`# tests -> api -> services -> <repo root>`) every fixture below
// mirrors.
const TESTS_DIR = 'services/api/tests'

describe('extractPythonTestAssertedPaths', () => {
  it('extracts a path built directly off parents[N]', () => {
    const src = `_TF = Path(__file__).resolve().parents[3] / "scripts" / "error_branch_coverage.py"\n`
    expect(extractPythonTestAssertedPaths(src, TESTS_DIR)).toEqual([
      'scripts/error_branch_coverage.py',
    ])
  })

  it('extracts a path built through an intermediate root variable', () => {
    const src = [
      '_REPO_ROOT = Path(__file__).resolve().parents[3]',
      '_TF = _REPO_ROOT / "infra" / "environments" / "dev" / "plugin-storage.core.tf"',
    ].join('\n')
    expect(extractPythonTestAssertedPaths(src, TESTS_DIR)).toEqual([
      'infra/environments/dev/plugin-storage.core.tf',
    ])
  })

  it('extracts an inline chain never assigned to its own name', () => {
    const src = [
      '_REPO_ROOT = Path(__file__).resolve().parents[3]',
      '_IS_INSTANCE = (_REPO_ROOT / "biffo.core.json").is_file()',
    ].join('\n')
    expect(extractPythonTestAssertedPaths(src, TESTS_DIR)).toEqual(['biffo.core.json'])
  })

  it('extracts a chain built through a transitive second variable', () => {
    const src = [
      'REPO_ROOT = Path(__file__).resolve().parents[3]',
      'IMPORTS_ROOT = REPO_ROOT / "db" / "imports"',
      'on_disk = {p for p in IMPORTS_ROOT.rglob("*.sql")}',
    ].join('\n')
    expect(extractPythonTestAssertedPaths(src, TESTS_DIR)).toEqual(['db/imports'])
  })

  it('extracts a chain used as a local variable inside a method (#1454 negative control)', () => {
    // The exact shape #1454 exists to catch, retargeted at a path this
    // template does not own: a Python test resolving the repo root and
    // asserting over apps/portal content, which is NOT in core-manifest.json's
    // templateOwned list at the file granularity this scanner reaches for
    // a hypothetical un-owned single file under a user-owned tree.
    const src = [
      'def _thing(self):',
      '    root = Path(__file__).resolve().parents[3]',
      '    return (root / "apps" / "portal" / "some-instance-file.tsx").read_text()',
    ].join('\n')
    expect(extractPythonTestAssertedPaths(src, TESTS_DIR)).toEqual([
      'apps/portal/some-instance-file.tsx',
    ])
  })

  it('returns nothing for a file with no parents[N] chain', () => {
    const src = 'def test_noop():\n    assert True\n'
    expect(extractPythonTestAssertedPaths(src, TESTS_DIR)).toEqual([])
  })

  it('resolves parents[N] relative to the FILE, not always the repo root', () => {
    // The real bug this fixture pins: services/api/tests/x.py -> parents[1]
    // is services/api (2 segments up from tests/), NOT the repo root. Before
    // this was fixed, "src/api" was reported as an unowned top-level path.
    const src = '_API_SRC = Path(__file__).resolve().parents[1] / "src" / "api"'
    expect(extractPythonTestAssertedPaths(src, TESTS_DIR)).toEqual(['services/api/src/api'])
  })

  it('resolves a skeleton-nested file relative to ITS root, not the template root', () => {
    // _skeletons/sibling-template/services/api/tests/x.py -> parents[3] is
    // _skeletons/sibling-template, not this repo's root. Before this was
    // fixed, the skeleton's own apps/frontend/src read as a bare top-level
    // "apps/frontend/src" — unowned by the manifest — instead of the (wholly
    // template-owned, because _skeletons/ is) nested path it actually is.
    const skeletonDir = '_skeletons/sibling-template/services/api/tests'
    const src = [
      'REPO_ROOT = Path(__file__).resolve().parents[3]',
      'FRONTEND_SRC = REPO_ROOT / "apps" / "frontend" / "src"',
    ].join('\n')
    expect(extractPythonTestAssertedPaths(src, skeletonDir)).toEqual([
      '_skeletons/sibling-template',
      '_skeletons/sibling-template/apps/frontend/src',
    ])
  })
})

describe('findPythonTestAssertedPaths', () => {
  it('reaches something in this repo (vacuity check — a scanner that finds nothing proves nothing)', () => {
    const paths = findPythonTestAssertedPaths(repoRoot)
    expect(paths.length).toBeGreaterThan(0)
  })

  it('reaches the known #1454 shapes (9 files enumerated in the issue) — coverage is observable, not assumed', () => {
    const paths = findPythonTestAssertedPaths(repoRoot)
    // Sample of paths these files are known to build — proves the walk is
    // actually executing against services/api/tests/, not merely compiling.
    expect(paths).toContain('modules/cloud/aws/auth/main.tf')
    expect(paths).toContain('scripts/error_branch_coverage.py')
    expect(paths).toContain('scripts/resolve-core-version.sh')
    expect(paths).toContain('db/imports')
    expect(paths).toContain('biffo.core.json')
  })

  it('does not reach into services/api/tests/instance/ (explicitly userOwned)', () => {
    // No fixture currently exists there with a parents[N] chain, so this
    // documents intent: isTemplateOwned() must exclude that subtree even if
    // one is added later, guarded indirectly by the self-filter in
    // findPythonTestAssertedPaths reusing the same core-manifest.json rules
    // every other guard in this file relies on.
    const paths = findPythonTestAssertedPaths(repoRoot)
    expect(paths.every((p) => !p.startsWith('services/api/tests/instance/'))).toBe(true)
  })
})
