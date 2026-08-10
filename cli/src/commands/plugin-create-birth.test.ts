import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { GitAdapter } from '../adapters/git/index.js'
import { findSkeletonRoot } from '../lib/plugin-scaffold.js'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runPluginCreate } from './plugin-create.js'

const repoRoot = join(new URL('.', import.meta.url).pathname, '..', '..', '..')
const SKELETON = findSkeletonRoot(new URL('.', import.meta.url).pathname, 'plugin-template')

/**
 * A committer identity for the real `git init`/`commit` this test drives.
 *
 * `runPluginCreate`'s standalone path does `git init` → `git add` → `git
 * commit` in one synchronous run inside `runStandaloneCreate` (via the real
 * `GitAdapter`), so there is no point between them to run `git config` in the
 * new repo the way other integration tests here do (`pgtest-diff-check.test.ts`,
 * `rewrite-scope-check.test.ts`, `core-tags.test.ts`: `git('config', 'user.email',
 * ...)` right after `git init`). Setting the standard `GIT_AUTHOR_*`/
 * `GIT_COMMITTER_*` env vars instead reaches the same commit without needing a
 * gap in the sequence, and `GitAdapter`'s `execa` calls inherit `process.env`
 * with nothing overriding it.
 *
 * This is what the hosted CI runner was actually missing: it has no
 * `user.name`/`user.email` git config at all (a developer workstation
 * usually does), so `git commit` failed with "empty ident name" — a second,
 * narrower instance of exactly the class this PR fixes (works on a machine
 * that already has the setup, broken on the one that has none of it).
 */
function withCommitIdentity<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  process.env['GIT_AUTHOR_NAME'] = 'Biffo Test'
  process.env['GIT_AUTHOR_EMAIL'] = 'test@example.com'
  process.env['GIT_COMMITTER_NAME'] = 'Biffo Test'
  process.env['GIT_COMMITTER_EMAIL'] = 'test@example.com'
  return fn().finally(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
}

/** Standard git identity env vars, for the second commit each test drives directly. */
const COMMIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'Biffo Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Biffo Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

/** Scaffolds a standalone plugin repo exactly as `biffo plugin create --standalone` does. */
async function scaffoldStandalone(): Promise<{ projectRoot: string; destDir: string }> {
  const projectRoot = makeTmpDir('biffo-plugin-birth')
  mkdirSync(join(projectRoot, 'services'), { recursive: true })

  await withCommitIdentity(() =>
    runPluginCreate(
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
    ),
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
      env: COMMIT_IDENTITY_ENV,
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

    // A stub `npx` first on PATH, same technique as
    // `packaged-scripts.test.ts` ("A stub `npx` first on PATH: this asserts
    // WHICH version the bridge asks for, without a network round trip.
    // Running the real npx here would make the test slow, flaky, and
    // dependent on the registry."). `scripts/biffo.sh` only needs `npx` to
    // exist and exit 0 — this test is about the bridge finding a resolvable
    // pin at all, not about what the resolved CLI itself then does.
    const stubBin = join(projectRoot, 'stubbin')
    mkdirSync(stubBin, { recursive: true })
    writeFileSync(join(stubBin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const result = await execa('git', ['commit', '--allow-empty', '-m', 'chore: second commit'], {
      cwd: destDir,
      reject: false,
      env: { ...COMMIT_IDENTITY_ENV, PATH: `${stubBin}:${process.env['PATH'] ?? ''}` },
    })

    expect(result.exitCode).toBe(0)
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'no biffo.core.json, no .biffo-shared-version, and no cli/ here',
    )

    rmSync(projectRoot, { recursive: true, force: true })
  })
})
