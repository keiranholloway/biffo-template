/**
 * Pairing test: a scaffolded plugin's vendored seed must pass the instance's
 * own DDL import guard (issue #2132).
 *
 * Three template-owned pieces each shipped correct and green on their own:
 * the skeleton's `db/seed/000_default_widget.sql`, the vendor step that copies
 * it to `db/imports/_plugin-<name>/` (`plugin-seed-vendor.ts`), and the
 * guard `services/api/tests/test_ddl_import_conventions.py` that derives the
 * schema a module must select from its import directory's name. No test held
 * the three together, so a plugin created and installed with nothing
 * hand-edited went red on the instance's required Python check.
 *
 * This test is that missing test. It runs the REAL scaffolder over the REAL
 * skeleton, the REAL vendor step, then executes the guard's own check methods
 * (the same ones pytest parametrises over `db/imports/*`) against the vendored
 * directory — nothing here restates what the guard requires.
 *
 * Needs `uv` (the guard is Python). Like plugin-scaffold.test.ts it skips
 * without one locally, but in CI (`CI` set) a missing `uv` FAILS rather than
 * skipping: a pairing check that silently does not run is the shape that let
 * the pair ship separately in the first place.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { validateManifest } from './plugin-manifest.js'
import { deriveNames, findSkeletonRoot, scaffoldPlugin } from './plugin-scaffold.js'
import { pluginSeedImportDir, vendorPluginSeed } from './plugin-seed-vendor.js'
import { readFileSync } from 'node:fs'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const GUARD_TESTS_DIR = join(REPO_ROOT, 'services', 'api', 'tests')
const API_SRC_DIR = join(REPO_ROOT, 'services', 'api', 'src')
const realSkeleton = findSkeletonRoot(
  fileURLToPath(new URL('.', import.meta.url)),
  'plugin-template',
)

const hasUv = spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0

// Runs every guard check method (idempotency + name resolution) over every
// module in the vendored directory (see the inline note on skips below).
// Prints the modules it covered so the denominator is visible, and exits
// non-zero on zero modules.
const RUN_GUARD = `
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
sys.path.insert(0, sys.argv[3])  # services/api/src, where pytest finds api
import test_ddl_import_conventions as guard
from api.ddl_import import list_sql_files

import_dir = Path(sys.argv[2])
config = guard._load_config(import_dir)
files = list(list_sql_files(import_dir))
if not files:
    print("NO MODULES FOUND in " + str(import_dir))
    sys.exit(3)

failures = []
checked = 0
for path in files:
    module = guard.GuardedModule(path, config)
    for cls in (guard.TestDdlImportIdempotency, guard.TestDdlImportNameResolution):
        for name in sorted(n for n in dir(cls) if n.startswith("test_")):
            checked += 1
            try:
                getattr(cls(), name)(module)
            except guard.pytest.skip.Exception as exc:
                # "module creates no policies" is a legitimate not-applicable
                # skip; a grandfather skip is not — nothing about a freshly
                # vendored seed is "already applied".
                if "grandfathered" in str(exc):
                    failures.append(f"{cls.__name__}.{name}[{path.name}]: {exc}")
            except AssertionError as exc:
                failures.append(f"{cls.__name__}.{name}[{path.name}]: {exc}")
print(f"modules={[p.name for p in files]} checks={checked}")
for f in failures:
    print("FAIL " + f)
sys.exit(1 if failures else 0)
`

describe('a scaffolded plugin seed, vendored, against the instance DDL guard (#2132)', () => {
  it.runIf(realSkeleton && (hasUv || process.env.CI))(
    'passes every check test_ddl_import_conventions.py applies to db/imports',
    () => {
      expect(hasUv, 'uv is required in CI to run the Python guard').toBe(true)

      const pluginDir = join(makeTmpDir('seed-pairing-plugin'), 'a5-throwaway')
      const instanceDir = makeTmpDir('seed-pairing-instance')

      // The same two steps `biffo plugin create` and `biffo plugin install` run.
      scaffoldPlugin(realSkeleton!, pluginDir, deriveNames('a5-throwaway'))
      const manifest = validateManifest(
        JSON.parse(readFileSync(join(pluginDir, 'biffo.plugin.json'), 'utf8')),
      )
      const vendored = vendorPluginSeed(pluginDir, manifest, instanceDir)
      expect(
        vendored.vendored,
        'the skeleton must declare a seed for this test to mean anything',
      ).toBe(true)

      const importDir = join(instanceDir, pluginSeedImportDir(manifest.name))
      expect(existsSync(join(importDir, '000_default_widget.sql'))).toBe(true)

      const run = spawnSync(
        'uv',
        ['run', '--frozen', 'python', '-c', RUN_GUARD, GUARD_TESTS_DIR, importDir, API_SRC_DIR],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      )
      const output = `${run.stdout}${run.stderr}`
      expect(output, 'guard did not report the modules it covered').toContain(
        "modules=['000_default_widget.sql']",
      )
      expect(output).not.toMatch(/FAIL /)
      expect(run.status, output).toBe(0)
    },
    300_000,
  )
})
