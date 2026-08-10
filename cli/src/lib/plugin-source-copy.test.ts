import { execa } from 'execa'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { copyPluginSource } from './plugin-source-copy.js'

/**
 * Guards #1477: `plugin install --local` / `plugin upgrade --local` once
 * copied a source checkout's `.worktrees/`, `.venv` and caches wholesale
 * into the instance, because the copy had no notion of `.gitignore` at all —
 * only a hardcoded denylist that a `.worktrees/` directory was never on. A
 * scanner reported the same secret three times: once genuine, once per
 * vendored worktree.
 *
 * Reverting `copyPluginSource` to the pre-fix `cpSync` + `LOCAL_COPY_EXCLUDES`
 * filter (i.e. dropping the `git ls-files` branch entirely) makes every test
 * below that touches an ignored, non-denylisted directory fail — proving
 * they observe the actual defect, not a theory of it.
 */
async function initGitRepo(dir: string): Promise<void> {
  await execa('git', ['init', '-q'], { cwd: dir })
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execa('git', ['config', 'user.name', 'Test'], { cwd: dir })
}

describe('copyPluginSource', () => {
  it('excludes a directory only .gitignore knows about, that the denylist does not', async () => {
    const source = makeTmpDir('plugin-source')
    await initGitRepo(source)
    writeFileSync(join(source, '.gitignore'), '.worktrees/\n')
    writeFileSync(join(source, 'biffo.plugin.json'), '{}')

    // The exact shape of #1477: a git worktree living under the checkout,
    // carrying a secret-scanner-tripping fixture and its own real files.
    mkdirSync(join(source, '.worktrees', 'channel-plan-agent'), { recursive: true })
    writeFileSync(
      join(source, '.worktrees', 'channel-plan-agent', 'other-agents-work.py'),
      'SECRET = "AKIAIOSFODNN7EXAMPLE"\n',
    )

    // A cache directory nobody put on the denylist — the whole point of
    // reading .gitignore instead of maintaining a fixed list.
    mkdirSync(join(source, '.some_unlisted_cache'), { recursive: true })
    writeFileSync(join(source, '.gitignore'), '.worktrees/\n.some_unlisted_cache/\n')
    writeFileSync(join(source, '.some_unlisted_cache', 'junk'), 'junk')

    await execa('git', ['add', '-A'], { cwd: source })
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: source })

    const target = makeTmpDir('plugin-target')
    const result = await copyPluginSource(source, target)

    expect(result.usedGitIgnoreRules).toBe(true)
    expect(existsSync(join(target, 'biffo.plugin.json'))).toBe(true)
    expect(existsSync(join(target, '.worktrees'))).toBe(false)
    expect(existsSync(join(target, '.some_unlisted_cache'))).toBe(false)
  })

  it('still copies real, uncommitted files mid-iteration (untracked but not ignored)', async () => {
    const source = makeTmpDir('plugin-source')
    await initGitRepo(source)
    writeFileSync(join(source, '.gitignore'), '.worktrees/\n')
    writeFileSync(join(source, 'biffo.plugin.json'), '{}')
    await execa('git', ['add', '-A'], { cwd: source })
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: source })

    // A new, real, not-yet-committed file — the expected case mid-iteration
    // per plugin-upgrade.ts's own docstring. Must still be copied.
    writeFileSync(join(source, 'new_route.py'), 'x = 1\n')

    const target = makeTmpDir('plugin-target')
    await copyPluginSource(source, target)

    expect(existsSync(join(target, 'new_route.py'))).toBe(true)
  })

  it('falls back to the denylist when the source is not a git working tree', async () => {
    const source = makeTmpDir('plugin-source')
    writeFileSync(join(source, 'biffo.plugin.json'), '{}')
    mkdirSync(join(source, '.venv'), { recursive: true })
    writeFileSync(join(source, '.venv', 'pyvenv.cfg'), '')
    mkdirSync(join(source, '.worktrees', 'foo'), { recursive: true })
    writeFileSync(join(source, '.worktrees', 'foo', 'file.py'), 'x = 1\n')

    const target = makeTmpDir('plugin-target')
    const result = await copyPluginSource(source, target)

    expect(result.usedGitIgnoreRules).toBe(false)
    expect(existsSync(join(target, 'biffo.plugin.json'))).toBe(true)
    expect(existsSync(join(target, '.venv'))).toBe(false)
    // Honestly documented limitation of the fallback: a directory not on the
    // fixed denylist (unlike .venv) is not excluded when there is no git to ask.
    expect(existsSync(join(target, '.worktrees'))).toBe(true)
  })

  it('does not create stray top-level entries beyond what git tracks', async () => {
    const source = makeTmpDir('plugin-source')
    await initGitRepo(source)
    writeFileSync(join(source, '.gitignore'), '.ruff_cache/\n')
    writeFileSync(join(source, 'biffo.plugin.json'), '{}')
    mkdirSync(join(source, '.ruff_cache'), { recursive: true })
    writeFileSync(join(source, '.ruff_cache', 'cache.bin'), '')
    await execa('git', ['add', '-A'], { cwd: source })
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: source })

    const target = makeTmpDir('plugin-target')
    await copyPluginSource(source, target)

    expect(readdirSync(target).sort()).toEqual(['.gitignore', 'biffo.plugin.json'])
  })
})
