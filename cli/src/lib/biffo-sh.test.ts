import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * `scripts/biffo.sh` resolves which copy of the CLI to run, and at which
 * version. It is a shell script, so it is exercised here as one: a real git
 * repo, and a stub `npx` on PATH that prints its arguments instead of hitting
 * the network. Nothing about the script is instrumented for the test.
 *
 * The property under test is #667: an instance mid-upgrade must be checked by
 * the version it is upgrading FROM. `biffo core upgrade --apply` rewrites
 * biffo.core.json to the target before committing, so reading the working tree
 * pinned the guard to a version that is not published yet — and the commit-msg
 * hook died on `npm error notarget`, with --no-verify no help because CI runs
 * the same check.
 */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
  'biffo.sh',
)

describe('scripts/biffo.sh version resolution (#667)', () => {
  let repo: string
  let binDir: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'biffo-sh-'))
    binDir = mkdtempSync(join(tmpdir(), 'biffo-bin-'))
    // Stub npx: echo the invocation rather than resolving a package.
    const stub = join(binDir, 'npx')
    writeFileSync(stub, '#!/usr/bin/env sh\necho "NPX $*"\n')
    chmodSync(stub, 0o755)
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(binDir, { recursive: true, force: true })
  })

  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  }
  function writeCoreJson(version: string): void {
    writeFileSync(join(repo, 'biffo.core.json'), `${JSON.stringify({ version }, null, 2)}\n`)
  }
  function run(): string {
    return execFileSync('sh', [SCRIPT, 'check', 'ownership'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    })
  }

  it('pins to the committed version, not the target an upgrade just wrote', () => {
    writeCoreJson('0.127.2') // published
    git('add', '-A')
    git('commit', '-qm', 'initial')
    writeCoreJson('0.133.1') // what `core upgrade --apply` writes; not on npm yet

    const out = run()

    expect(out).toContain('@biffo/cli@0.127.2')
    expect(out).not.toContain('0.133.1')
  })

  it('still pins to the committed version when the rewrite is staged', () => {
    // The actual commit-msg case: the hook runs with the new file staged.
    writeCoreJson('0.127.2')
    git('add', '-A')
    git('commit', '-qm', 'initial')
    writeCoreJson('0.133.1')
    git('add', '-A')

    expect(run()).toContain('@biffo/cli@0.127.2')
  })

  it('falls back to the working tree before the first commit exists', () => {
    // A fresh `biffo init`: the file is there, HEAD is not.
    writeCoreJson('0.127.2')
    expect(run()).toContain('@biffo/cli@0.127.2')
  })

  it('falls back to the working tree when the file is new and uncommitted', () => {
    git('commit', '-qm', 'empty', '--allow-empty')
    writeCoreJson('0.127.2')
    expect(run()).toContain('@biffo/cli@0.127.2')
  })

  it('tracks the committed version forward once the upgrade lands', () => {
    writeCoreJson('0.127.2')
    git('add', '-A')
    git('commit', '-qm', 'initial')
    writeCoreJson('0.133.1')
    git('add', '-A')
    git('commit', '-qm', 'upgrade')

    expect(run()).toContain('@biffo/cli@0.133.1')
  })

  it('fails loudly when no version can be read from either source', () => {
    writeFileSync(join(repo, 'biffo.core.json'), '{}\n')
    expect(() => run()).toThrow(/carries no readable version/)
  })
})
