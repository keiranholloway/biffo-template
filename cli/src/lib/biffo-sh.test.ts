import { execFileSync } from 'node:child_process'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

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
    repo = makeTmpDir('biffo-sh')
    binDir = makeTmpDir('biffo-bin')
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

/**
 * `claim` never depends on `cli/`'s TypeScript toolchain (biffo-fleet#1231).
 *
 * `scripts/biffo.sh` used to `exec` straight into `cli/node_modules/.bin/tsx`
 * with no existence check, for every subcommand including `claim` — even
 * though `claim` (`cli/src/commands/claim.ts`) is a pure passthrough to the
 * dependency-free `scripts/claim.sh`. In a worktree where `pnpm install`
 * never completed in `cli/`, that `exec` hit a missing binary and exited 127
 * with no reconciling action: the caller saw "not found" and the claim/label
 * was left stale, silently blocking re-dispatch of the same issue. Five
 * confirmed instances since 2026-08-31, one costing ~1.25M tokens for zero
 * progress.
 *
 * The fix dispatches `claim` straight to `scripts/claim.sh`, unconditionally,
 * before biffo.sh ever looks at `cli/` — so releasing (or claiming, or
 * reaffirming) an issue can no longer depend on that toolchain at all.
 */
describe('scripts/biffo.sh: claim bypasses the tsx toolchain entirely (biffo-fleet#1231)', () => {
  let repo: string

  beforeEach(() => {
    repo = makeTmpDir('biffo-sh-claim')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('mkdir', ['-p', join(repo, 'scripts')])
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  function writeClaimStub(body: string): void {
    writeFileSync(join(repo, 'scripts', 'claim.sh'), body, { mode: 0o755 })
  }

  function run(args: string[]): { code: number; out: string } {
    try {
      const out = execFileSync('sh', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' })
      return { code: 0, out }
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string }
      return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') }
    }
  }

  it("reaches claim.sh directly when cli/ does not exist at all -- today's exact failure shape, fixed", () => {
    // No `cli/` directory whatsoever -- the worst case (#1231's actual
    // shape: `pnpm install` never ran in `cli/`, so neither the directory
    // nor tsx exist). Before this fix, biffo.sh's final line would `exec`
    // a nonexistent tsx binary and exit 127 having never reached claim.sh.
    writeClaimStub('#!/usr/bin/env sh\necho "claim.sh ran: $*"\nexit 0\n')

    const { code, out } = run(['claim', '1234', '--release', 'sometoken'])

    expect(code).toBe(0)
    expect(out).toContain('claim.sh ran: 1234 --release sometoken')
  })

  it('reaches claim.sh directly even with a cli/ directory present but no tsx built', () => {
    // The more common real shape: `cli/` exists (this IS the template
    // checkout) but `pnpm install` never completed inside it, so
    // `cli/node_modules/.bin/tsx` is missing. Before the fix this hit the
    // final `exec "$root/cli/node_modules/.bin/tsx" ...` line and failed
    // with exit 127 and no reconciling action.
    execFileSync('mkdir', ['-p', join(repo, 'cli')])
    writeClaimStub('#!/usr/bin/env sh\necho "claim.sh ran: $*"\nexit 0\n')

    const { code, out } = run(['claim', '999', '--as', 'tok-0903-abcd'])

    expect(code).toBe(0)
    expect(out).toContain('claim.sh ran: 999 --as tok-0903-abcd')
  })

  it("passes claim.sh's exit code straight through (2 = cannot tell, never flattened)", () => {
    writeClaimStub('#!/usr/bin/env sh\nexit 2\n')

    const { code } = run(['claim', '1234', '--release', 'sometoken'])

    expect(code).toBe(2)
  })

  it('does not intercept other subcommands -- only claim bypasses tsx', () => {
    // No claim.sh stub here on purpose: this proves the guard is scoped to
    // the literal `claim` subcommand, not every invocation of biffo.sh.
    const binDir = makeTmpDir('biffo-sh-claim-npx')
    const npx = join(binDir, 'npx')
    writeFileSync(npx, '#!/usr/bin/env sh\necho "NPX $*"\n', { mode: 0o755 })
    writeFileSync(join(repo, '.biffo-shared-version'), 'core-v1.2.3\n')

    const out = execFileSync('sh', [SCRIPT, 'wait-for-checks', '42'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    })
    rmSync(binDir, { recursive: true, force: true })

    expect(out).toContain('NPX')
    expect(out).toContain('wait-for-checks')
  })
})
