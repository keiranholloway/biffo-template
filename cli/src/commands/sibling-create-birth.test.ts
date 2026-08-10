import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { SiblingConfigSchema } from '../config/sibling-schema.js'
import { defaultSiblingTemplateRoot, writeSiblingTemplate } from './sibling-create.js'
import { makeTmpDir } from '../test-utils/tmp.js'

const repoRoot = join(new URL('.', import.meta.url).pathname, '..', '..', '..')

let SKELETON: string | undefined
try {
  SKELETON = defaultSiblingTemplateRoot()
} catch {
  SKELETON = undefined
}

/** Standard git identity env vars — see the identical note in plugin-create-birth.test.ts. */
const COMMIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'Biffo Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Biffo Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

const SIBLING_CONFIG = SiblingConfigSchema.parse({
  project: { name: 'reports', description: 'Reports sibling' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'reports' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
  core: { config_path: './biffo.config.json', path_prefix: 'reports' },
})

/**
 * Scaffolds a sibling repo tree exactly as `runSiblingCreate`'s `pushSkeleton`
 * step does — real skeleton, real `writeSiblingTemplate` — but locally, with
 * no GitHub/AWS calls, so the birth property (can this repo make a second
 * commit?) can be exercised in CI without live credentials.
 */
function scaffoldSibling(): string {
  const targetDir = makeTmpDir('biffo-sibling-birth')
  writeSiblingTemplate(SKELETON!, targetDir, SIBLING_CONFIG, {
    coreProjectName: 'core-app',
    pathPrefix: 'reports',
    templateVersion: '1.2.3',
  })
  return targetDir
}

/**
 * A "birth" test for the `sibling create` path, instance 2 of the class
 * described in #1459.
 *
 * `sibling-create.ts:710` (`writeSiblingTemplate`) has stamped
 * `.biffo-shared-version` since #1230 — weeks before the identical defect was
 * found and fixed on the plugin path (#1449/#1473). So this path has been
 * CORRECT the whole time, but only by history: nothing ever asserted it, which
 * is exactly the gap #1459 names — a repo whose second commit works only
 * because nobody has yet made the change that would break it.
 *
 * This test scaffolds a sibling repo tree with the real skeleton and the real
 * `.githooks/`, arms the shared hooks dispatcher the way `pnpm install`'s
 * `prepare` script does, and asserts a second commit succeeds — mirroring
 * `plugin-create-birth.test.ts` exactly, including the fail-before/pass-after
 * pair that proves the assertion can actually fail.
 */
describe.runIf(SKELETON)('a sibling repo is born able to commit (#1459)', () => {
  it('stamps .biffo-shared-version at scaffold time', () => {
    const targetDir = scaffoldSibling()

    const pin = join(targetDir, '.biffo-shared-version')
    expect(existsSync(pin)).toBe(true)
    expect(readFileSync(pin, 'utf8')).toMatch(/^core-v\d+\.\d+\.\d+\n$/)

    rmSync(targetDir, { recursive: true, force: true })
  })

  it('FAILS without the stamp: a second commit is rejected by the version-pin bridge', async () => {
    // Reproduces the pre-#1230 shape directly: scaffold the repo (which
    // writeSiblingTemplate makes stamp the pin), then delete
    // .biffo-shared-version to simulate a birth path that never wrote it —
    // the same state the plugin path was actually found in for #1449 — and
    // assert the second commit fails with the exact bridge message.
    const targetDir = scaffoldSibling()
    rmSync(join(targetDir, '.biffo-shared-version'), { force: true })

    await execa('git', ['init', '-b', 'dev'], { cwd: targetDir })
    await execa('git', ['add', '.'], { cwd: targetDir })
    await execa('git', ['commit', '-m', 'feat: scaffold reports sibling app (ADR-0007)'], {
      cwd: targetDir,
      env: COMMIT_IDENTITY_ENV,
    })
    await execa('sh', [join(repoRoot, 'scripts', 'install-hooks.sh')], { cwd: targetDir })

    const result = await execa('git', ['commit', '--allow-empty', '-m', 'chore: second commit'], {
      cwd: targetDir,
      reject: false,
      env: COMMIT_IDENTITY_ENV,
    })

    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain(
      'no biffo.core.json, no .biffo-shared-version, and no cli/ here',
    )

    rmSync(targetDir, { recursive: true, force: true })
  })

  it('PASSES with the stamp: the second commit succeeds', async () => {
    const targetDir = scaffoldSibling()

    await execa('git', ['init', '-b', 'dev'], { cwd: targetDir })
    await execa('git', ['add', '.'], { cwd: targetDir })
    await execa('git', ['commit', '-m', 'feat: scaffold reports sibling app (ADR-0007)'], {
      cwd: targetDir,
      env: COMMIT_IDENTITY_ENV,
    })
    await execa('sh', [join(repoRoot, 'scripts', 'install-hooks.sh')], { cwd: targetDir })

    // A stub `npx` first on PATH — same technique as plugin-create-birth.test.ts:
    // this proves the bridge finds a resolvable pin at all, without a real
    // network round trip through the version-pinned CLI it would otherwise exec.
    const stubBin = join(targetDir, '..', 'stubbin-sibling')
    mkdirSync(stubBin, { recursive: true })
    const npxStub = join(stubBin, 'npx')
    await execa('sh', ['-c', `printf '#!/bin/sh\\nexit 0\\n' > ${npxStub} && chmod 755 ${npxStub}`])

    const result = await execa('git', ['commit', '--allow-empty', '-m', 'chore: second commit'], {
      cwd: targetDir,
      reject: false,
      env: { ...COMMIT_IDENTITY_ENV, PATH: `${stubBin}:${process.env['PATH'] ?? ''}` },
    })

    expect(result.exitCode).toBe(0)
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'no biffo.core.json, no .biffo-shared-version, and no cli/ here',
    )

    rmSync(targetDir, { recursive: true, force: true })
    rmSync(stubBin, { recursive: true, force: true })
  })
})
