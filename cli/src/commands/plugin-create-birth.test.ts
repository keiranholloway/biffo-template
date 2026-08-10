import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { GitAdapter } from '../adapters/git/index.js'
import { findSkeletonRoot } from '../lib/plugin-scaffold.js'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runPluginCreate } from './plugin-create.js'

const repoRoot = join(new URL('.', import.meta.url).pathname, '..', '..', '..')
const SKELETON = findSkeletonRoot(new URL('.', import.meta.url).pathname, 'plugin-template')

/** Scaffolds a standalone plugin repo exactly as `biffo plugin create --standalone` does. */
async function scaffoldStandalone(): Promise<{ projectRoot: string; destDir: string }> {
  const projectRoot = makeTmpDir('biffo-plugin-birth')
  mkdirSync(join(projectRoot, 'services'), { recursive: true })

  await runPluginCreate(
    'acme-crm',
    {
      firstParty: false,
      standalone: true,
      skeletonRoot: SKELETON!,
      dryRun: false,
      commit: true,
      cwd: projectRoot,
    },
    { git: new GitAdapter() },
  )

  return { projectRoot, destDir: join(projectRoot, 'biffo-plugin-acme-crm') }
}

/**
 * A "birth" test for #1449, and instance 1 of the class described in #1459:
 * a defect that lives only in the first-time transition from "just scaffolded"
 * to "a working repo", invisible to any test against an already-adopted repo.
 *
 * Every EXISTING plugin repo works, because `shared-sync.sh` stamped
 * `.biffo-shared-version` into it long ago. That is exactly why no steady-state
 * test — one that scaffolds once and asserts the tree looks right — could ever
 * have caught this: the scaffold commit itself succeeds (it lands before hooks
 * are armed, per `runStandaloneCreate`'s own comment), and only the SECOND
 * commit exercises the hook that fails.
 *
 * This test scaffolds a standalone plugin repo with the real `GitAdapter` and
 * the real `.githooks/`, no mocks, arms the shared hooks dispatcher the way
 * `pnpm install`'s `prepare` script does, and asserts a second commit succeeds.
 * `.githooks/commit-msg` calls `sh scripts/biffo.sh check ownership …`
 * unconditionally, so without the fix `scripts/biffo.sh` — finding no
 * `biffo.core.json`, no `.biffo-shared-version` and no `cli/` — exits 2 with
 * exactly the message reported live in #1449, and the commit is rejected.
 */
describe.runIf(SKELETON)('a standalone plugin repo is born able to commit (#1449)', () => {
  it('stamps .biffo-shared-version before the first commit', async () => {
    const { projectRoot, destDir } = await scaffoldStandalone()

    const pin = join(destDir, '.biffo-shared-version')
    expect(existsSync(pin)).toBe(true)
    expect(readFileSync(pin, 'utf8')).toMatch(/^core-v\d+\.\d+\.\d+\n$/)

    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('FAILS before the fix: a second commit is rejected by the version-pin bridge', async () => {
    // Reproduces the live symptom directly: scaffold the repo (which the fix
    // makes stamp the pin), then DELETE `.biffo-shared-version` to reproduce
    // the pre-#1449 state, arm the real hooks, and assert the second commit
    // fails with the exact message from the issue. This is the fail-first half
    // of the birth test — proof it actually catches the defect, not just that
    // the happy path is green.
    const { projectRoot, destDir } = await scaffoldStandalone()
    rmSync(join(destDir, '.biffo-shared-version'), { force: true })

    await execa('sh', [join(repoRoot, 'scripts', 'install-hooks.sh')], { cwd: destDir })

    const result = await execa('git', ['commit', '--allow-empty', '-m', 'chore: second commit'], {
      cwd: destDir,
      reject: false,
    })

    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain(
      'no biffo.core.json, no .biffo-shared-version, and no cli/ here',
    )

    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('PASSES after the fix: the second commit succeeds', async () => {
    const { projectRoot, destDir } = await scaffoldStandalone()

    await execa('sh', [join(repoRoot, 'scripts', 'install-hooks.sh')], { cwd: destDir })

    const result = await execa('git', ['commit', '--allow-empty', '-m', 'chore: second commit'], {
      cwd: destDir,
      reject: false,
    })

    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'no biffo.core.json, no .biffo-shared-version, and no cli/ here',
    )
    expect(result.exitCode).toBe(0)

    rmSync(projectRoot, { recursive: true, force: true })
  }, 30000)
})
