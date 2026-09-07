/**
 * `biffo check plugin-allowlist-convention` (biffo-template#1545's wiring,
 * #1906's satellite fix).
 *
 * `runPluginAllowlistConventionCheck` takes no options — it always resolves
 * its root via `git rev-parse --show-toplevel` — so these tests mock the
 * underlying `execa` package (not `../lib/exec.js`, which just wraps it) to
 * point that resolution at a disposable tmp tree, the same technique
 * `check-branch-protection.test.ts` uses for its own git call. The
 * underlying `checkAllowlistConvention` drift-detection logic is already
 * exercised directly, against a copy of this repo's real modules, in
 * `../lib/plugin-allowlist-convention.test.ts`; this file proves the CI
 * entrypoint's own error handling, not the audit itself.
 *
 * The satellite-shaped case (#1906) is the one this file exists to add: a
 * repo with none of the four template-owned module sources this guard reads
 * (`modules/cloud/aws/compute/main.tf`, `modules/plugins/_template/main.tf`,
 * `modules/cloud/aws/plugin-allowlist/{main,variables}.tf`) used to crash
 * `runPluginAllowlistConventionCheck` with an uncaught "cannot read" error
 * on every satellite in the shared-sync rehearsal. A genuine drift on a real
 * copy of the four sources must still fail exactly as before; that is
 * exercised here too (reusing the same "copy the real modules, patch one"
 * fixture the lib-level test uses), so the fix cannot be read as silencing
 * the real signal along with the false one.
 *
 * #1906's first fix treated ANY of the four sources being missing as
 * "satellite, skip" — which also silently waved through a real
 * template/instance tree missing just ONE of the four (a rename or an
 * accidental delete), the exact drift this guard exists to catch
 * (biffo-template#1908). The "only SOME missing" case below reproduces that
 * regression directly against a full copy of the real modules with one file
 * removed, and asserts it still fails loudly (exit 1) rather than reporting
 * "not applicable".
 *
 * #1908's own fix (ALL FOUR missing, not ANY) left a THIRD gap open, closed
 * here: a real sibling app (`biffo sibling create`'s own scaffold,
 * `_skeletons/sibling-template/modules/`) carries its OWN
 * `modules/cloud/aws/compute/main.tf` — a real Lambda compute module for its
 * own BFF, unrelated to the plugin-hosting one this guard reads — so a real
 * sibling is missing only THREE of the four sources, never all four, and the
 * #1906/#1908 file-count heuristic ran the audit anyway and threw "cannot
 * read modules/plugins/_template/main.tf" on a perfectly healthy sibling
 * (biffo-template#1943). `runPluginAllowlistConventionCheck` now asks
 * `classifyRepoOwnership` directly rather than counting which of four paths
 * happen to exist, so the fixtures below add (or omit) `core-manifest.json`/
 * `biffo.core.json` — the actual repo-type markers — instead of relying on
 * file-count alone.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import {
  ALLOWLIST_MAIN_TF,
  ALLOWLIST_VARIABLES_TF,
  COMPUTE_MAIN_TF,
  PLUGIN_TEMPLATE_MAIN_TF,
} from '../lib/plugin-allowlist-convention.js'
import { runPluginAllowlistConventionCheck } from './check-plugin-allowlist-convention.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

// This test file lives at cli/src/scripts/, so ../../.. is the repo root —
// same derivation ../lib/plugin-allowlist-convention.test.ts uses from one
// directory up.
const REPO_ROOT = join(__dirname, '..', '..', '..')
const SOURCES = [
  COMPUTE_MAIN_TF,
  PLUGIN_TEMPLATE_MAIN_TF,
  ALLOWLIST_MAIN_TF,
  ALLOWLIST_VARIABLES_TF,
]

function write(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

/** A copy of the real modules, so a test can break one and watch the guard
 * fire — plus a `core-manifest.json` marker, so `classifyRepoOwnership`
 * reads this fixture as a template/instance tree rather than a satellite
 * (the guard now asks that directly instead of counting which of the four
 * module sources happen to exist; see this file's #1943 note above). */
function copyRealModules(dest: string): void {
  for (const relative of SOURCES) {
    mkdirSync(dirname(join(dest, relative)), { recursive: true })
    cpSync(join(REPO_ROOT, relative), join(dest, relative))
  }
  write(dest, 'core-manifest.json', '{}')
}

function patch(root: string, relative: string, from: string, to: string): void {
  const path = join(root, relative)
  const before = readFileSync(path, 'utf8')
  expect(before, `${relative} no longer contains ${from}`).toContain(from)
  writeFileSync(path, before.replace(from, to))
}

function setRoot(root: string): void {
  vi.mocked(execa).mockResolvedValue({ stdout: root } as never)
}

let exitCode: number | undefined

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error(`process.exit(${String(code)})`)
  }) as never)
})

describe('runPluginAllowlistConventionCheck', () => {
  it('is not applicable (exit 0, no crash) in a satellite tree with none of the four module sources (#1906)', async () => {
    const root = makeTmpDir('plugin-allowlist-satellite')
    write(root, 'apps/frontend/package.json', '{"name": "satellite-app"}')
    setRoot(root)

    await expect(runPluginAllowlistConventionCheck()).resolves.toBeUndefined()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged.toLowerCase()).toContain('not applicable')
  })

  it('is not applicable (exit 0, no crash) in a real sibling tree that carries its OWN unrelated compute/main.tf (#1943)', async () => {
    // The actual reported shape: a real `biffo sibling create` scaffold has
    // its own modules/cloud/aws/compute/main.tf (a real Lambda module for
    // its own BFF) but none of the other three plugin-hosting sources, and
    // no core-manifest.json/biffo.core.json at all. That is missing THREE of
    // the four, never all four, which the #1906/#1908 file-count heuristic
    // ran anyway and crashed on.
    const root = makeTmpDir('plugin-allowlist-real-sibling')
    write(root, 'apps/frontend/package.json', '{"name": "tabsii-geo"}')
    mkdirSync(dirname(join(root, COMPUTE_MAIN_TF)), { recursive: true })
    cpSync(join(REPO_ROOT, COMPUTE_MAIN_TF), join(root, COMPUTE_MAIN_TF))
    setRoot(root)

    await expect(runPluginAllowlistConventionCheck()).resolves.toBeUndefined()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged.toLowerCase()).toContain('not applicable')
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toBe('')
  })

  it('STILL fails (exit 1) on a real glob drift against a full copy of the four sources', async () => {
    const root = makeTmpDir('plugin-allowlist-real-violation')
    copyRealModules(root)
    patch(root, ALLOWLIST_MAIN_TF, '-plugin-${name}-role/*', '-plugins-${name}-role/*')
    setRoot(root)

    await expect(runPluginAllowlistConventionCheck()).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('drift found')
  })

  it('fails loudly (exit 1), NOT "not applicable", when only SOME of the four sources are missing (#1908)', async () => {
    const root = makeTmpDir('plugin-allowlist-partial-tree')
    copyRealModules(root)
    // A real template/instance tree missing just one of the four sources —
    // e.g. `variables.tf` renamed or accidentally deleted — is drift, not a
    // satellite. It must fail closed exactly like the pre-#1907 behaviour,
    // not be silently classified as "not applicable" (#1907's regression).
    rmSync(join(root, ALLOWLIST_VARIABLES_TF))
    setRoot(root)

    await expect(runPluginAllowlistConventionCheck()).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported.toLowerCase()).not.toContain('not applicable')
    expect(reported).toContain('could not run')
    expect(reported).toContain(ALLOWLIST_VARIABLES_TF)
  })
})
