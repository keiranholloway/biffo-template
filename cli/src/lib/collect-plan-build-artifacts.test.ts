import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp'

// cli/src/lib/ -> cli/src/ -> cli/ -> repo root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(repoRoot, 'scripts/collect-plan-build-artifacts.mjs')

/**
 * A minimal `terraform show -json` plan carrying one archive_file
 * `output_path`, in the shape real captured output actually has it (see
 * plan-build-artifacts.test.ts's fixtures) -- just enough of the envelope
 * for extractArchiveFileOutputPaths to find it.
 */
function planWithArchiveFile(outputPath: string) {
  return {
    prior_state: {
      values: {
        root_module: {
          resources: [{ mode: 'data', type: 'archive_file', values: { output_path: outputPath } }],
        },
      },
    },
    resource_changes: [],
  }
}

function run(args: string[], cwd: string) {
  return execFileSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' })
}

describe('collect-plan-build-artifacts.mjs (CLI)', () => {
  it('prints the repo-root-relative path of an archive_file output that exists, outside .build/ (#1772)', () => {
    const dir = makeTmpDir('tfbuild-cli')
    // Mirrors the real repro's tree shape: infra/environments/dev, and a
    // module two levels up whose archive_file writes into its own build/.
    const envDir = join(dir, 'infra/environments/dev')
    const moduleDir = join(dir, 'modules/lambda-thing/build')
    mkdirSync(envDir, { recursive: true })
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, 'thing.zip'), 'not a real zip, just needs to exist')
    writeFileSync(
      join(envDir, 'plan.json'),
      JSON.stringify(planWithArchiveFile('../../../modules/lambda-thing/build/thing.zip')),
    )

    const out = run(['plan.json', dir], envDir)
    expect(out.trim()).toBe('modules/lambda-thing/build/thing.zip')
  })

  it('excludes an archive_file output already under <tf-working-dir>/.build/ -- transported whole by the #1774 fix', () => {
    const dir = makeTmpDir('tfbuild-cli')
    const envDir = join(dir, 'infra/environments/dev')
    const buildDir = join(envDir, '.build')
    mkdirSync(buildDir, { recursive: true })
    writeFileSync(join(buildDir, 'root-thing.zip'), 'not a real zip, just needs to exist')
    writeFileSync(
      join(envDir, 'plan.json'),
      JSON.stringify(planWithArchiveFile('./.build/root-thing.zip')),
    )

    const out = run(['plan.json', dir], envDir)
    expect(out.trim()).toBe('')
  })

  it('skips an output_path that has not actually been written to disk (apply-deferred data source)', () => {
    const dir = makeTmpDir('tfbuild-cli')
    const envDir = join(dir, 'infra/environments/dev')
    mkdirSync(envDir, { recursive: true })
    // No file created at modules/other/build/other.zip -- resolved in the
    // plan's JSON but never written, which happens when the read itself is
    // deferred to apply (see plan-build-artifacts.mjs's header).
    writeFileSync(
      join(envDir, 'plan.json'),
      JSON.stringify(planWithArchiveFile('../../../modules/other/build/other.zip')),
    )

    const out = run(['plan.json', dir], envDir)
    expect(out.trim()).toBe('')
  })

  it('warns and skips an output_path that resolves outside the repo checkout, rather than failing the plan', () => {
    const dir = makeTmpDir('tfbuild-cli')
    const envDir = join(dir, 'infra/environments/dev')
    mkdirSync(envDir, { recursive: true })
    writeFileSync(
      join(envDir, 'plan.json'),
      // Climbs above the repo root entirely.
      JSON.stringify(planWithArchiveFile('../../../../outside/thing.zip')),
    )

    const result = execFileSync('node', [SCRIPT, 'plan.json', dir], {
      cwd: envDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(result.trim()).toBe('')
  })

  it('exits 2 with no output when the plan file is missing (fail closed, mirrors check-destructive-plan.mjs)', () => {
    const dir = makeTmpDir('tfbuild-cli')
    const envDir = join(dir, 'infra/environments/dev')
    mkdirSync(envDir, { recursive: true })

    expect(() => run(['plan.json', dir], envDir)).toThrow()
  })

  it('returns nothing for a plan with no archive_file at all', () => {
    const dir = makeTmpDir('tfbuild-cli')
    const envDir = join(dir, 'infra/environments/dev')
    mkdirSync(envDir, { recursive: true })
    writeFileSync(join(envDir, 'plan.json'), JSON.stringify({ resource_changes: [] }))

    const out = run(['plan.json', dir], envDir)
    expect(out.trim()).toBe('')
  })
})
