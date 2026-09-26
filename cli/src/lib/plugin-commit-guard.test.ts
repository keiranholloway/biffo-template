/**
 * Structural guard for biffo-template#2108: a `biffo plugin` command must not commit into an instance without going through
 * `commitPluginChange`/`withRefreshedLock`, or `uv.lock` goes stale again.
 *
 * It reads the real command sources, not a restatement of them, and enumerates `plugin-*.ts` by glob so a NEW plugin command is
 * inside the denominator automatically — a hardcoded list of the four known commands would silently exempt the fifth.
 *
 * Raw `git.commit(` calls that are legitimately not an instance commit are pinned by count with the reason beside them; a new
 * one changes the count and fails here until somebody decides which kind it is.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMMANDS_DIR = join(new URL('.', import.meta.url).pathname, '..', 'commands')

const commandFiles = readdirSync(COMMANDS_DIR).filter(
  (f) => /^plugin-[a-z-]+\.ts$/.test(f) && !f.endsWith('.test.ts'),
)

const RAW_COMMIT_ALLOWED: Record<string, { count: number; why: string }> = {
  'plugin-create.ts': {
    count: 2,
    why: 'standalone plugin repo (`git init` in a NEW repo, uv.lock pre-substituted and asserted present) and the registry clone',
  },
  'plugin-install.ts': {
    count: 2,
    why: 'the dashboard-registry commit in a separate repo, and the core commit that follows `withRefreshedLock`',
  },
  'plugin-upgrade.ts': {
    count: 2,
    why: 'relockIfDependenciesChanged runs before staging, with its own soft-fail reporting (#1569); not folded in here',
  },
}

const COMMIT_CALL = /\b(?:git|deps\.git)\.commit\(/g

describe('plugin commands commit through the shared lock-refreshing step (#2108)', () => {
  it('discovers the plugin commands (the denominator is not empty)', () => {
    expect(commandFiles).toEqual(
      expect.arrayContaining([
        'plugin-create.ts',
        'plugin-install.ts',
        'plugin-sync-migrations.ts',
        'plugin-uninstall.ts',
        'plugin-upgrade.ts',
      ]),
    )
  })

  it.each(commandFiles)('%s has no unaccounted raw git.commit', (file) => {
    const src = readFileSync(join(COMMANDS_DIR, file), 'utf8')
    const raw = (src.match(COMMIT_CALL) ?? []).length
    expect(raw).toBe(RAW_COMMIT_ALLOWED[file]?.count ?? 0)
  })

  it.each(['plugin-create.ts', 'plugin-uninstall.ts', 'plugin-sync-migrations.ts'])(
    '%s commits via commitPluginChange',
    (file) => {
      expect(readFileSync(join(COMMANDS_DIR, file), 'utf8')).toMatch(/commitPluginChange\(/)
    },
  )

  it('plugin-install.ts refreshes the lock through the shared helper before its core commit', () => {
    const src = readFileSync(join(COMMANDS_DIR, 'plugin-install.ts'), 'utf8')
    const lock = src.indexOf('withRefreshedLock(')
    const coreCommit = src.indexOf('await deps.git.commit(options.cwd')
    expect(lock).toBeGreaterThan(-1)
    expect(coreCommit).toBeGreaterThan(lock)
  })

  it('every allowlisted file still exists (a rename must not orphan its entry)', () => {
    for (const file of Object.keys(RAW_COMMIT_ALLOWED)) expect(commandFiles).toContain(file)
  })
})
