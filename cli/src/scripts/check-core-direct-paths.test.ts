/**
 * `biffo check core-direct-paths --estate <dir>` (#1377, corrected 2026-08-10;
 * self-check scoping fixed in #1943).
 *
 * The workflow's first real run against the live estate reported nine
 * findings, and every one was a false positive: `--core-src` was resolved to
 * biffo-template's OWN `services/api/src` for every sibling, when a
 * sibling's deployed core is the INSTANCE it was scaffolded against
 * (`biffo.sibling.json`'s `core_project`). These tests exercise
 * `runCoreDirectPathsCheck`'s `--estate` resolution path directly, rather
 * than reasoning about it from the source — the same discipline
 * `check-branch-protection.test.ts` uses for its own CI entrypoint.
 *
 * `execa` is mocked (not `../lib/exec.js`, which just wraps it) so the
 * `git rev-parse --show-toplevel` resolution can be pointed at a disposable
 * root — needed for the self-check-default tests below, which (unlike the
 * `--estate` tests above them) exercise the code path that reads `root`
 * directly. The pre-existing `--estate` tests never depended on the real
 * value, so a default mock keeps them passing unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runCoreDirectPathsCheck } from './check-core-direct-paths.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

function setRoot(root: string): void {
  vi.mocked(execa).mockResolvedValue({ stdout: root } as never)
}

let exitCode: number | undefined

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // `process.exit` is `never`-typed and really does end the process, so it
  // has to become a throw for the assertions after it to be reachable.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error(`process.exit(${String(code)})`)
  }) as never)
  // The `--estate` tests below always pass explicit `sibling`/`frontendSrc`
  // options, so `root`'s value is unused in them — but it is still resolved,
  // so it needs somewhere harmless to point.
  setRoot(makeTmpDir('core-direct-default-root'))
})

/** Build `<estate>/<sibling>` with a `biffo.sibling.json` naming
 * `coreProject`, and `<estate>/<coreProject>` as its instance (when
 * `withInstance` is true — omitting it is how a test exercises "the instance
 * is missing from this checkout"). */
function buildEstate(opts: {
  estateDir: string
  sibling: string
  coreProject?: string
  withInstance?: boolean
}) {
  const { estateDir, sibling, coreProject, withInstance = true } = opts
  const siblingDir = join(estateDir, sibling)
  const frontendSrcDir = join(siblingDir, 'apps', 'frontend', 'src')
  mkdirSync(join(frontendSrcDir, 'lib'), { recursive: true })

  if (coreProject !== undefined) {
    writeFileSync(
      join(siblingDir, 'biffo.sibling.json'),
      JSON.stringify({ name: sibling, core_project: coreProject }),
    )
  }

  let coreApiSrcDir: string | undefined
  if (coreProject !== undefined && withInstance) {
    coreApiSrcDir = join(estateDir, coreProject, 'services', 'api', 'src', 'domains')
    mkdirSync(coreApiSrcDir, { recursive: true })
  }

  return { frontendSrcDir, coreApiSrcDir }
}

describe('runCoreDirectPathsCheck --estate resolution', () => {
  it("resolves the sibling's OWN instance core and matches against it, not biffo-template's", async () => {
    const estateDir = makeTmpDir('core-direct-estate-ok')
    const { frontendSrcDir, coreApiSrcDir } = buildEstate({
      estateDir,
      sibling: 'tabsii-intake',
      coreProject: 'tabsii-platform',
    })
    writeFileSync(
      join(frontendSrcDir, 'lib', 'demo-requests.ts'),
      "const CORE_API_URL = ''\nfetch(`${CORE_API_URL}/api/v1/public/demo-requests`)\n",
    )
    writeFileSync(
      join(coreApiSrcDir as string, 'demo_requests.py'),
      'router = APIRouter(prefix="/public/demo-requests", tags=["public"])\n',
    )

    await runCoreDirectPathsCheck({
      sibling: 'tabsii-intake',
      frontendSrc: frontendSrcDir,
      estate: estateDir,
    })

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('audited 1 core-direct call site(s)')
    // The denominator line must name the resolved core -- the whole point of
    // #1377's second finding is that this must be visible without anyone
    // reproducing the resolution by hand.
    expect(logged).toContain('(core project: tabsii-platform)')
  })

  it('fails loud, does not fall back to this repo, when biffo.sibling.json is missing', async () => {
    const estateDir = makeTmpDir('core-direct-estate-no-config')
    const { frontendSrcDir } = buildEstate({
      estateDir,
      sibling: 'orphan-sibling',
      coreProject: undefined,
    })

    await expect(
      runCoreDirectPathsCheck({
        sibling: 'orphan-sibling',
        frontendSrc: frontendSrcDir,
        estate: estateDir,
      }),
    ).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('biffo.sibling.json')
  })

  it("fails loud when core_project's instance is missing from this estate checkout", async () => {
    const estateDir = makeTmpDir('core-direct-estate-missing-instance')
    const { frontendSrcDir } = buildEstate({
      estateDir,
      sibling: 'tabsii-marketplace',
      coreProject: 'tabsii-platform',
      withInstance: false, // the instance was never cloned into this estate
    })

    await expect(
      runCoreDirectPathsCheck({
        sibling: 'tabsii-marketplace',
        frontendSrc: frontendSrcDir,
        estate: estateDir,
      }),
    ).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('tabsii-platform')
    expect(reported).toContain('does not exist')
  })

  it('an explicit --core-src overrides --estate resolution', async () => {
    const estateDir = makeTmpDir('core-direct-estate-override')
    const { frontendSrcDir } = buildEstate({
      estateDir,
      sibling: 'tabsii-intake',
      coreProject: 'tabsii-platform',
      withInstance: false, // would fail resolution if --estate were consulted
    })
    const overrideCoreDir = makeTmpDir('core-direct-override-core')
    mkdirSync(join(overrideCoreDir, 'domains'), { recursive: true })
    writeFileSync(
      join(frontendSrcDir, 'lib', 'whoami.ts'),
      "fetch('/api/v1/whoami')\n", // no core-direct call sites at all
    )
    writeFileSync(
      join(overrideCoreDir, 'domains', 'whoami.py'),
      'router = APIRouter(prefix="/whoami")\n',
    )

    await runCoreDirectPathsCheck({
      sibling: 'tabsii-intake',
      frontendSrc: frontendSrcDir,
      estate: estateDir,
      coreSrc: overrideCoreDir,
    })

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).not.toContain('core project:')
  })
})

describe('runCoreDirectPathsCheck self-check defaults (#1943)', () => {
  it('skips cleanly in a sibling tree whose services/api/src is its own unrelated BFF', async () => {
    const root = makeTmpDir('core-direct-selfcheck-satellite')
    // Shaped exactly like a real `biffo sibling create` scaffold: no
    // `_skeletons/` (never ships to a satellite) and its own BFF at
    // `services/api/src`, whose routers legitimately declare an
    // `APIRouter()` with no `prefix=` — the real shape that reported "BLIND
    // (core)" against a real sibling (tabsii-geo) before this fix.
    write(root, 'apps/frontend/package.json', '{"name": "satellite-app"}')
    write(root, 'services/api/src/api/routers/whoami.py', 'router = APIRouter()\n')
    setRoot(root)

    await runCoreDirectPathsCheck()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('skipped')
    const errored = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(errored).toBe('')
  })

  it('still runs the self-check (does not skip) in the template itself', async () => {
    const root = makeTmpDir('core-direct-selfcheck-template')
    write(root, 'core-manifest.json', '{}')
    mkdirSync(join(root, '_skeletons', 'sibling-template', 'apps', 'frontend', 'src'), {
      recursive: true,
    })
    write(root, 'services/api/src/api/main.py', 'router = APIRouter(prefix="/whoami")\n')
    setRoot(root)

    await runCoreDirectPathsCheck()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).not.toContain('skipped —')
    expect(logged).toContain('audited 0 core-direct call site(s)')
  })

  it('still runs the self-check (does not skip) in an instance tree', async () => {
    const root = makeTmpDir('core-direct-selfcheck-instance')
    write(root, 'biffo.core.json', JSON.stringify({ version: '1.0.0' }))
    mkdirSync(join(root, '_skeletons', 'sibling-template', 'apps', 'frontend', 'src'), {
      recursive: true,
    })
    write(root, 'services/api/src/api/main.py', 'router = APIRouter(prefix="/whoami")\n')
    setRoot(root)

    await runCoreDirectPathsCheck()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).not.toContain('skipped —')
    expect(logged).toContain('audited 0 core-direct call site(s)')
  })

  it('an explicit --sibling/--frontend-src/--estate invocation runs regardless of the calling repo (satellite-shaped)', async () => {
    // The self-check-defaults gate must only fire when NO override was
    // given -- an explicit, ad-hoc audit of some OTHER tree is not the
    // self-check and must not be skipped just because it happens to be
    // invoked from within a satellite.
    const callingRoot = makeTmpDir('core-direct-selfcheck-satellite-caller')
    write(callingRoot, 'apps/frontend/package.json', '{"name": "satellite-app"}')
    setRoot(callingRoot)

    const estateDir = makeTmpDir('core-direct-selfcheck-explicit-estate')
    const { frontendSrcDir, coreApiSrcDir } = buildEstate({
      estateDir,
      sibling: 'tabsii-intake',
      coreProject: 'tabsii-platform',
    })
    writeFileSync(
      join(frontendSrcDir, 'lib', 'demo-requests.ts'),
      "const CORE_API_URL = ''\nfetch(`${CORE_API_URL}/api/v1/public/demo-requests`)\n",
    )
    writeFileSync(
      join(coreApiSrcDir as string, 'demo_requests.py'),
      'router = APIRouter(prefix="/public/demo-requests", tags=["public"])\n',
    )

    await runCoreDirectPathsCheck({
      sibling: 'tabsii-intake',
      frontendSrc: frontendSrcDir,
      estate: estateDir,
    })

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).not.toContain('skipped —')
    expect(logged).toContain('audited 1 core-direct call site(s)')
  })
})

function write(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}
