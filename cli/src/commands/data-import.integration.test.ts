/**
 * End-to-end integration test for runDataImport().
 *
 * Unlike data-import.test.ts (which passes a mocked GitAdapter), this
 * exercises the real GitAdapter — an actual `git clone` of a local file://
 * repo and an actual `git commit`. No registry/HTTP involved for this
 * command (unlike plugin-install's equivalent), so no MSW setup needed.
 */
import { execa } from 'execa'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitAdapter } from '../adapters/git/index.js'
import { runDataImport } from './data-import.js'
import { makeTmpDir, removeTmpDir } from '../test-utils/tmp.js'

async function initGitRepo(dir: string): Promise<void> {
  await execa('git', ['init', '--initial-branch=main'], { cwd: dir })
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execa('git', ['config', 'user.name', 'Biffo Test'], { cwd: dir })
}

async function commitAll(dir: string, message: string): Promise<void> {
  await execa('git', ['add', '-A'], { cwd: dir })
  await execa('git', ['commit', '-m', message], { cwd: dir })
}

describe('runDataImport — end-to-end', () => {
  let dataSourceRepo: string
  let projectRoot: string

  beforeEach(async () => {
    // A local "DDL source repo" the CLI will `git clone`.
    dataSourceRepo = makeTmpDir('biffo-data-source')
    await initGitRepo(dataSourceRepo)
    mkdirSync(join(dataSourceRepo, 'ddl', 'modules'), { recursive: true })
    writeFileSync(
      join(dataSourceRepo, 'ddl', 'modules', '000_schema.sql'),
      'CREATE SCHEMA IF NOT EXISTS tabsii;\n',
    )
    writeFileSync(
      join(dataSourceRepo, 'ddl', 'modules', '001_tables.sql'),
      'CREATE TABLE tabsii.widgets (id uuid PRIMARY KEY);\n',
    )
    writeFileSync(join(dataSourceRepo, 'README.md'), '# Not SQL\n')
    await commitAll(dataSourceRepo, 'initial DDL source')

    // A local "Biffo project checkout" the CLI imports into.
    projectRoot = makeTmpDir('biffo-project')
    mkdirSync(join(projectRoot, 'services'), { recursive: true })
    await initGitRepo(projectRoot)
    writeFileSync(join(projectRoot, 'README.md'), '# Test project\n')
    await commitAll(projectRoot, 'chore: initial commit')
  })

  afterEach(() => {
    // Both were just written to by real `git` subprocesses -- see
    // `removeTmpDir`'s docstring for why a bare `rmSync` here is racy.
    removeTmpDir(dataSourceRepo)
    removeTmpDir(projectRoot)
  })

  // Explicit `token` on every file:// case below: without it, runDataImport
  // falls through to resolveDdlImportToken()'s `gh auth token` / interactive
  // prompt fallback — harmless (and fast) locally with `gh` authenticated,
  // but on a CI runner with no `gh` session it hits the prompt and hangs on
  // stdin, which is what actually caused this suite's first CI failure (not
  // clone speed, despite the misleading "Test timed out" message). A
  // file://-sourced test never needs real auth, so any non-empty string
  // here is fine — it only needs to short-circuit resolution.
  const UNUSED_TOKEN = 'unused-test-token'

  it('clones the real repo, copies only .sql files from --path, and commits', async () => {
    await runDataImport(
      'tabsii',
      {
        source: `file://${dataSourceRepo}`,
        path: 'ddl/modules',
        token: UNUSED_TOKEN,
        dryRun: false,
        cwd: projectRoot,
      },
      { git: new GitAdapter() },
    )

    const targetDir = join(projectRoot, 'db', 'imports', 'tabsii')
    expect(existsSync(join(targetDir, '000_schema.sql'))).toBe(true)
    expect(existsSync(join(targetDir, '001_tables.sql'))).toBe(true)
    expect(readFileSync(join(targetDir, '001_tables.sql'), 'utf8')).toContain(
      'CREATE TABLE tabsii.widgets',
    )

    // Only .sql files travel — not the source repo's README, not .git metadata.
    expect(existsSync(join(targetDir, 'README.md'))).toBe(false)
    expect(existsSync(join(targetDir, '.git'))).toBe(false)

    const log = await execa('git', ['log', '-1', '--pretty=%s'], { cwd: projectRoot })
    expect(log.stdout).toBe('feat(data): import tabsii (2 SQL file(s))')

    const status = await execa('git', ['status', '--porcelain'], { cwd: projectRoot })
    expect(status.stdout.trim()).toBe('')
  })

  it('supports a local directory source with no git clone at all', async () => {
    await runDataImport(
      'tabsii',
      { source: join(dataSourceRepo, 'ddl', 'modules'), dryRun: false, cwd: projectRoot },
      { git: new GitAdapter() },
    )

    expect(existsSync(join(projectRoot, 'db', 'imports', 'tabsii', '000_schema.sql'))).toBe(true)
  })

  it('supports --dry-run against a real clone with no filesystem or git side effects', async () => {
    await runDataImport(
      'tabsii',
      {
        source: `file://${dataSourceRepo}`,
        path: 'ddl/modules',
        token: UNUSED_TOKEN,
        dryRun: true,
        cwd: projectRoot,
      },
      { git: new GitAdapter() },
    )

    expect(existsSync(join(projectRoot, 'db', 'imports', 'tabsii'))).toBe(false)
    const status = await execa('git', ['status', '--porcelain'], { cwd: projectRoot })
    expect(status.stdout.trim()).toBe('')
  })
})
