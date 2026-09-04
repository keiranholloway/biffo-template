import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertInvokes, assertRunsCommand } from '../lib/workflow-run-commands.js'
import type { CoreManifest } from '../lib/core-manifest.js'
import { checkCommand } from './check.js'
import { makeTmpDir } from '../test-utils/tmp.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

/**
 * These guard the seam that lets an instance stop carrying `cli/`.
 *
 * An instance runs the guards from the published package via `scripts/biffo.sh`
 * (`biffo check ownership`), while the template runs the same subcommands from
 * its working tree. Rename or drop one and every instance's CI fails on a
 * command that no longer exists — in a repo that cannot fix it, which is the
 * failure class this change exists to remove.
 */
describe('biffo check', () => {
  const names = checkCommand.commands.map((c) => c.name()).sort()

  /**
   * The subcommands CI invokes on every PR. These are the seam: rename or drop
   * one and every instance's CI fails on a command that no longer exists.
   */
  const ciGuards = [
    'adr-numbering',
    'claim-invocation',
    'codeql-suppression',
    'cognito-invite-template',
    'core-direct-paths',
    'distribution-inventory',
    'eventbridge-log-permissions',
    'lambda-output',
    'migration-body-change',
    'orphan-ratchet',
    'ownership',
    'pipe-trap',
    'plugin-allowlist-convention',
    'plugin-collisions',
    'plugin-terraform',
    'plugin-tool-supply',
    'release-subject',
    'skeleton-drift',
    'terraform-input',
  ]

  /**
   * Subcommands that are deliberately NOT wired into per-PR CI. `biffo check
   * branch-protection` audits GitHub repo settings over the API rather than the
   * diff, so it belongs in a scheduled job, not a merge gate (#715). `biffo
   * check plugin-staleness` (#1547) is advisory for a different reason: an
   * instance may legitimately pin a plugin version, so drift moving is not a
   * defect the way an ownership violation is, and it must never fail a build
   * over that. `biffo check shared-file-reduction` (#1577) is here for a
   * third reason: it compares the canonical copy of a shared file against the
   * SATELLITE copy it is about to overwrite, and those two only exist
   * together inside a `scripts/shared-sync.sh` run — there is nothing in this
   * repo's own tree for a per-PR job to compare, so the sync invokes it at
   * the moment of the write. `biffo check instance-adoption` (#1538/#1570/
   * #1609) is here for the same shape as `branch-protection`: it has no
   * self-check default (there is nothing in THIS repo's own tree to compare
   * — biffo-template is the template, not an instance), and it needs a real
   * cloned instance tree passed via `--instance-dir`, so it runs from
   * `instance-adoption-report.yml` on a schedule, not from a per-PR diff.
   * `biffo check distribution-remote-state` (#1816) is here for the same
   * shape as `instance-adoption`: the claims it checks are about ANOTHER
   * repo's live content, which needs a real cross-repo `BIFFO_GITHUB_TOKEN`
   * a per-PR job does not carry, so it runs from
   * `distribution-remote-state-report.yml` on a schedule instead.
   * Listing all five here keeps that a stated choice — a new subcommand that
   * is neither a CI guard nor listed here fails the exhaustiveness assertion
   * below.
   */
  const auditOnly = [
    'branch-protection',
    'distribution-remote-state',
    'instance-adoption',
    'plugin-staleness',
    'shared-file-reduction',
  ]

  it('exposes exactly the guards CI invokes, plus the audits that run out of band', () => {
    expect(names).toEqual([...ciGuards, ...auditOnly].sort())
  })

  it('is registered on the root program, or the published binary has no guards', () => {
    const index = readFileSync(join(repoRoot, 'cli/src/index.ts'), 'utf8')
    expect(index).toContain('addCommand(checkCommand)')
  })

  // `ownership` and `release-subject` moved from `ci.yml` into
  // `release-guards.yml` in #1319 (so that job's `pull_request` trigger could
  // add `edited` without giving that to the whole build matrix — see that
  // file's header), so the guards are read from the UNION of both files
  // rather than from `ci.yml` alone. Any one guard living in only one of the
  // two files is still exactly the shape #718/#720 guard against.
  const CORE_WORKFLOW_FILES = ['ci.yml', 'release-guards.yml']

  it('invokes the guards through the dispatcher, not the workspace', () => {
    const workflow = CORE_WORKFLOW_FILES.map((file) =>
      readFileSync(join(repoRoot, '.github/workflows', file), 'utf8'),
    ).join('\n')
    // `pnpm --filter @biffo/cli` only works where cli/ exists — the template.
    expect(workflow).not.toContain('pnpm --filter @biffo/cli check')
    // Exact command membership, NOT `toContain` on the raw text. The substring
    // form asserts a prefix, so renaming a guard by extension
    // (plugin-collisions -> plugin-collisionsXX) left this passing over a
    // workflow that no longer ran the guard — #720 caught that by accident.
    for (const name of ciGuards) assertRunsCommand(workflow, `sh scripts/biffo.sh check ${name}`)
  })

  it.each(CORE_WORKFLOW_FILES)('%s does not run the out-of-band audits as a merge gate', (file) => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows', file), 'utf8')
    for (const name of auditOnly) expect(workflow).not.toContain(`check ${name}`)
  })

  it('the commit hook uses the dispatcher too', () => {
    // The real hook moved to the tracked .githooks/ (#838); .husky/commit-msg is
    // now only a forwarder for clones whose core.hooksPath has not moved yet.
    const hook = readFileSync(join(repoRoot, '.githooks/commit-msg'), 'utf8')
    // Token-boundary, not substring: the hook legitimately appends
    // `--staged "$1" || exit 1`, so exact equality is wrong here — but
    // `toContain` would also accept `check ownershipXX`, which runs nothing.
    assertInvokes(hook, 'sh scripts/biffo.sh check ownership')
    expect(hook).not.toContain('pnpm --filter @biffo/cli')
  })
})

describe('cli/ is no longer distributed to instances', () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'core-manifest.json'), 'utf8'),
  ) as CoreManifest

  /**
   * The point of the change. `cli/` is 31k lines of a scaffolding tool an
   * instance never develops and never deploys; template-owned, it was built,
   * linted, type-checked and tested in every tenant's CI on every core release,
   * and the template's own tests failed there routinely — in repos with no
   * stake in them and no way to fix them.
   */
  it('is absent from templateOwned', () => {
    expect(manifest.templateOwned).not.toContain('cli/')
  })

  it('leaves scripts/ owned, or the dispatcher never reaches an instance', () => {
    expect(manifest.templateOwned).toContain('scripts/')
  })

  /**
   * Not distributed, but still released. The CLI publishes from the same
   * `core-v*` tag as everything else, so the release job has to see a CLI-only
   * change — otherwise the fix is never tagged, never published, and no
   * instance can install it. Dropping `cli/` from templateOwned without adding
   * it here would break publishing silently, which is what this pins.
   */
  it('is listed as released, so a CLI-only change still cuts a version', () => {
    expect(manifest.released).toContain('cli/')
  })
})

describe('scripts/biffo.sh', () => {
  const script = join(repoRoot, 'scripts/biffo.sh')

  /**
   * Both branches, driven for real: a repo with `biffo.core.json` must reach for
   * the published package at that exact version, and one without must use the
   * local workspace. Asserting on the source instead would not catch a shell
   * bug, and this dispatcher runs in every guard invocation in every repo.
   */
  const dispatchFor = (instanceVersion: string | null): string => {
    const dir = makeTmpDir('biffo-dispatch')
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      if (instanceVersion !== null) {
        writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version: instanceVersion }))
      }
      // Shim npx/pnpm onto PATH so the exec is observable instead of real.
      const bin = join(dir, 'bin')
      execFileSync('mkdir', ['-p', bin])
      for (const name of ['npx', 'pnpm']) {
        const shim = join(bin, name)
        writeFileSync(shim, `#!/bin/sh\necho "${name} $*"\n`, { mode: 0o755 })
      }
      // The template branch execs tsx by ABSOLUTE path rather than resolving it
      // on PATH (#1109), so it cannot be shimmed the way npx/pnpm are — stub it
      // where the script actually looks. The absolute path is deliberate: a
      // PATH-resolved `tsx` could pick up an unrelated global install, and this
      // dispatcher runs in every guard invocation in every repo.
      const tsxDir = join(dir, 'cli', 'node_modules', '.bin')
      execFileSync('mkdir', ['-p', tsxDir])
      writeFileSync(join(tsxDir, 'tsx'), `#!/bin/sh\necho "tsx $*"\n`, { mode: 0o755 })
      return execFileSync('sh', [script, 'check', 'ownership'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      }).trim()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('an instance runs the published package, pinned to its own core version', () => {
    const out = dispatchFor('0.61.0')
    expect(out).toContain('npx')
    expect(out).toContain('@biffo/cli@0.61.0')
    expect(out).toContain('check ownership')
  })

  it('the template runs its working tree, not the last release', () => {
    const out = dispatchFor(null)
    // Asserts the INTENT — the working tree, not a published version — rather
    // than the launcher. It used to require `pnpm`, and #1109 replaced
    // `pnpm --filter @biffo/cli exec tsx` with tsx directly because `pnpm exec`
    // normalises every non-zero exit to 1: verified, the CLI exits 2 and pnpm
    // reports 1. The estate's wait/health scripts are three-valued (0 green,
    // 1 failed, 2 cannot tell, where 2 is never a pass), so a wrapper that
    // rewrites its child's status silently destroys that distinction.
    expect(out).toContain('src/index.ts')
    expect(out).toContain('tsx')
    expect(out).not.toContain('npx')
  })
})
