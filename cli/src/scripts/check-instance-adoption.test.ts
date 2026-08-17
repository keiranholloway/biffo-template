/**
 * `biffo check instance-adoption --instance-dir <dir>` (#1538/#1570/#1609).
 *
 * These exercise the CI entrypoint's wiring — argument handling, the
 * denominator line, and exit codes — the same discipline
 * `check-core-direct-paths.test.ts` uses for its own entrypoint. The
 * underlying adoption-pattern logic (`isAdopted`, `checkInstanceAdoption`) is
 * already fail-first tested against the REAL pre/post-PR#174
 * `keiranholloway/biffo-platform` `main.tf` in
 * `../lib/instance-adoption.test.ts`; this file does not repeat that fixture,
 * it proves the entrypoint calls it correctly and reports honestly.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runInstanceAdoptionCheck } from './check-instance-adoption.js'

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

/** A minimal (theirsDir, instanceDir) pair carrying the real
 * core-api-environment channel, mirroring the fixture shape in
 * instance-adoption.test.ts but trimmed to what the CLI wiring needs. */
function buildTrees(root: string) {
  const theirsDir = join(root, 'theirs')
  const instanceDir = join(root, 'instance')
  mkdirSync(join(theirsDir, 'infra/environments/dev'), { recursive: true })
  mkdirSync(join(instanceDir, 'infra/environments/dev'), { recursive: true })
  writeFileSync(
    join(theirsDir, 'infra/environments/dev/core-api-environment.core.tf'),
    'core_api_environment = merge(...)\n',
  )
  return { theirsDir, instanceDir }
}

describe('runInstanceAdoptionCheck', () => {
  it('exits 2 (cannot tell) when --instance-dir is omitted, rather than defaulting to a self-check', async () => {
    await expect(runInstanceAdoptionCheck({})).rejects.toThrow('process.exit(2)')

    expect(exitCode).toBe(2)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('--instance-dir is required')
  })

  it('exits 2 when --instance-dir does not exist, not a silent clean pass', async () => {
    const root = makeTmpDir('instance-adoption-check-missing')
    await expect(runInstanceAdoptionCheck({ instanceDir: join(root, 'nowhere') })).rejects.toThrow(
      'process.exit(2)',
    )

    expect(exitCode).toBe(2)
  })

  it('FAILS (exit 1) and names the gap by id, against a real unadopted instance tree', async () => {
    const root = makeTmpDir('instance-adoption-check-unadopted')
    const { theirsDir, instanceDir } = buildTrees(root)
    // No main.tf at all: the channel is applicable (theirsDir ships it) but
    // this instance has not consumed it — the exact shape biffo-platform sat
    // in for three days before PR #174, undetected because nothing but a
    // manual `biffo core upgrade` ever ran the check.
    await expect(
      runInstanceAdoptionCheck({ instance: 'fixture-unadopted', theirsDir, instanceDir }),
    ).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const denom = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(denom).toContain('examined 1 instance (fixture-unadopted)')
    expect(denom).toContain('1 applicable')
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('core-api-environment')
    expect(reported).toContain('does not consume')
  })

  it('PASSES (no exit) against a real adopted instance tree, and still states the denominator', async () => {
    const root = makeTmpDir('instance-adoption-check-adopted')
    const { theirsDir, instanceDir } = buildTrees(root)
    writeFileSync(
      join(instanceDir, 'infra/environments/dev/main.tf'),
      'module "core_api" {\n  environment_variables = merge(local.core_api_environment, {\n  })\n}\n',
    )

    await runInstanceAdoptionCheck({ instance: 'fixture-adopted', theirsDir, instanceDir })

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('examined 1 instance (fixture-adopted)')
    expect(logged).toContain('no adoption gaps')
  })

  it('defaults the label to the basename of --instance-dir when --instance is omitted', async () => {
    const root = makeTmpDir('instance-adoption-check-label')
    const { theirsDir, instanceDir } = buildTrees(root)
    writeFileSync(
      join(instanceDir, 'infra/environments/dev/main.tf'),
      'module "core_api" {\n  environment_variables = merge(local.core_api_environment, {\n  })\n}\n',
    )

    await runInstanceAdoptionCheck({ theirsDir, instanceDir })

    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain(`(${instanceDir.split('/').filter(Boolean).pop()})`)
  })
})
