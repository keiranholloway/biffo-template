/**
 * `biffo check core-direct-paths --estate <dir>` (#1377, corrected 2026-08-10).
 *
 * The workflow's first real run against the live estate reported nine
 * findings, and every one was a false positive: `--core-src` was resolved to
 * biffo-template's OWN `services/api/src` for every sibling, when a
 * sibling's deployed core is the INSTANCE it was scaffolded against
 * (`biffo.sibling.json`'s `core_project`). These tests exercise
 * `runCoreDirectPathsCheck`'s `--estate` resolution path directly, rather
 * than reasoning about it from the source — the same discipline
 * `check-branch-protection.test.ts` uses for its own CI entrypoint.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runCoreDirectPathsCheck } from './check-core-direct-paths.js'

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
