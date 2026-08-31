import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import { checkCoreOwnership, readDivergenceConfig } from './core-ownership-guard.js'
import {
  checkOrphanRatchet,
  type MergeFileFn,
  pathHasDivergenceTrailerInHistory,
  planCoreUpgrade,
} from './core-upgrade.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * Fix for #1718: `checkCoreOwnership` (core-ownership-guard.ts) has always
 * accepted a template-owned path via TWO independent routes — a
 * `biffo.divergence.json` `warnOnly` entry, OR a bare `Core-Divergence: <reason>`
 * commit trailer — and its own printed guidance names the trailer as a way
 * past. #1602/#1717 unified only the FIRST route into the #1026 orphan ratchet
 * (`planCoreUpgrade`'s `isDeclaredDivergent`); the trailer route was never
 * consulted there, so an operator who followed the guard's own suggestion still
 * hit the #1602 outcome: green at commit time, refused later at
 * `biffo core upgrade`, in front of whoever else was mid upgrade.
 *
 * This file is deliberately separate from
 * `core-upgrade-orphan-ratchet-divergence.test.ts` (the #1602 fix for the
 * config-file route) for the same reason that file is separate from
 * `core-ownership-orphan-disagreement.test.ts`: each pins one, distinct,
 * previously-open gap, and conflating them would blur which fix closed which
 * gap.
 *
 * ## #1815 and #1812 — the path-binding correction
 *
 * The first version of `pathHasDivergenceTrailerInHistory` trusted ANY commit
 * that touched `path` and carried a `Core-Divergence:` trailer ANYWHERE in its
 * message, regardless of what the trailer's own text was about. A prosecutor
 * found this unsound in general — verified live against `biffo-platform`,
 * 18.6% of tracked files read as "declared" purely because a commit that
 * happened to touch them ALSO happened to carry an unrelated trailer (#1815,
 * the real `3f27545e`/`package.json` squash-commit shape), and the same gap
 * meant the one real production caller (`orphan-ratchet-report.yml`, which
 * clones with `--depth 1`) read EVERY path as declared whenever the shallow
 * boundary commit carried any trailer at all (#1812). The tests below pin both
 * failures against the pre-fix shape and prove the corrected criteria — "the
 * commit is unambiguous" or "the trailer names the path" — resolve both
 * without reopening #1718's own undeclared-orphan case.
 */

const MANIFEST: CoreManifest = {
  version: 1,
  templateOwned: ['.github/workflows/'],
  userOwned: [],
}

// A manifest shaped like a real instance root: several individually-listed
// template-owned files, the same shape `3f27545e` (biffo-platform's real
// 168-template-file squash commit) touches in a single commit.
const ROOT_MANIFEST: CoreManifest = {
  version: 1,
  templateOwned: ['package.json', 'core-manifest.json', 'AGENTS.md'],
  userOwned: [],
}

const neverMerges: MergeFileFn = async () => {
  throw new Error('classify() reached the merge step for a path with no base and no theirs')
}

function w(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function initRepo(repo: string): void {
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
}

/** Commit whatever is currently staged/on disk with a message that may carry a
 * `Core-Divergence:` trailer. Written via `-F <file>` rather than `-m`, the
 * same reason AGENTS.md gives for every commit this estate's own agents make:
 * a trailer body containing something shell-special must never be interpolated
 * through `-m`. */
function commit(repo: string, message: string): void {
  const msgFile = join(repo, '.git', 'COMMIT_MSG_FIXTURE')
  writeFileSync(msgFile, message)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-F', msgFile])
}

/** A fake `git` runner that dispatches on the subcommand (`args[2]`, after
 * `-C <dir>`), matching the sequence `pathHasDivergenceTrailerInHistory`
 * actually issues: `log`, then (only when a candidate trailer exists)
 * `rev-parse --is-shallow-repository`, then per-commit `diff-tree`. A
 * subcommand the test does not expect to be called throws, so an accidental
 * extra git invocation (e.g. `diff-tree` on a commit that should have been
 * skipped as a shallow graft) fails the test loudly rather than silently. */
function fakeGit(handlers: {
  log: string
  isShallow?: string
  graftHashes?: string
  diffTree?: (hash: string) => string
}): (args: string[]) => string {
  return (args: string[]): string => {
    const sub = args[2]
    if (sub === 'log') return handlers.log
    if (sub === 'rev-parse') {
      if (handlers.isShallow === undefined) throw new Error('unexpected rev-parse call')
      return `${handlers.isShallow}\n`
    }
    if (sub === 'rev-list') {
      if (handlers.graftHashes === undefined) throw new Error('unexpected rev-list call')
      return `${handlers.graftHashes}\n`
    }
    if (sub === 'diff-tree') {
      const hash = args[args.length - 1]
      if (!handlers.diffTree) throw new Error(`unexpected diff-tree call for ${hash}`)
      return handlers.diffTree(hash)
    }
    throw new Error(`unexpected git subcommand: ${sub}`)
  }
}

describe('pathHasDivergenceTrailerInHistory — the pure lookup, with a fake git', () => {
  it('finds a Core-Divergence trailer on an unambiguous, single-file commit', () => {
    const log = fakeGit({
      log: '\x02deadbeef\x01fix: add a divergent workflow\n\nCore-Divergence: real-Postgres RLS lane\n',
      isShallow: 'false',
      diffTree: () => '.github/workflows/rls.yml\n',
    })
    expect(
      pathHasDivergenceTrailerInHistory('/repo', '.github/workflows/rls.yml', MANIFEST, log),
    ).toBe(true)
  })

  it('returns false when no commit touching the path carries the trailer', () => {
    const log = fakeGit({ log: '\x02deadbeef\x01fix: add a workflow\n\nno trailer here\n' })
    expect(
      pathHasDivergenceTrailerInHistory('/repo', '.github/workflows/rls.yml', MANIFEST, log),
    ).toBe(false)
  })

  it('fails CLOSED — not open — when git cannot answer', () => {
    // The opposite default from gitTrackedFiles: an un-inspectable tree must
    // NOT read as "declared", or every plain (non-git) fixture directory this
    // module's own other tests build would silently defang the orphan ratchet.
    const failing = (): string => {
      throw new Error('git: command not found')
    }
    expect(pathHasDivergenceTrailerInHistory('/repo', 'any/path', MANIFEST, failing)).toBe(false)
  })

  it('does not accept a passing mention of the words inside prose', () => {
    // Same anchoring rule as parseDivergenceTrailer itself (core-ownership-guard.ts)
    // — reused, not re-derived, so this is really testing the reuse rather than
    // a second copy of the regex.
    const log = fakeGit({ log: '\x02deadbeef\x01fix: discuss Core-Divergence: later maybe\n' })
    expect(pathHasDivergenceTrailerInHistory('/repo', 'any/path', MANIFEST, log)).toBe(false)
  })

  describe('#1815 — a multi-file commit only amnesties the path its trailer actually names', () => {
    const log =
      '\x023f27545e\x01' +
      'chore(core): upgrade template core 0.204.3 -> 0.249.8\n\n' +
      'Core-Convergence: 169 template-owned files from 0.204.3 to 0.249.7\n' +
      "Core-Divergence: package.json keeps this instance's bounded undici override\n"

    // Shaped exactly like the real repro: one squash commit whose DIFF touches
    // three template-owned files, but whose trailer reason names only
    // package.json.
    const diffTree = (): string => 'package.json\ncore-manifest.json\nAGENTS.md\n'

    it('recognises the path the trailer actually names', () => {
      const git = fakeGit({ log, isShallow: 'false', diffTree })
      expect(pathHasDivergenceTrailerInHistory('/repo', 'package.json', ROOT_MANIFEST, git)).toBe(
        true,
      )
    })

    it(
      'does NOT amnesty a co-committed template-owned file the trailer never mentions — ' +
        'this is the line that fails against the pre-#1815-fix code',
      () => {
        const git = fakeGit({ log, isShallow: 'false', diffTree })
        expect(
          pathHasDivergenceTrailerInHistory('/repo', 'core-manifest.json', ROOT_MANIFEST, git),
        ).toBe(false)
        expect(pathHasDivergenceTrailerInHistory('/repo', 'AGENTS.md', ROOT_MANIFEST, git)).toBe(
          false,
        )
      },
    )

    it(
      'criterion (1) must bind to the SAME path that made the commit unambiguous, not just ' +
        'any single template-owned file the commit happened to touch — caught live against ' +
        "biffo-platform's real c88e158a commit (package.json + README.md + pnpm-lock.yaml)",
      () => {
        // A commit touching exactly ONE template-owned file (package.json)
        // alongside any number of USER-owned ones is unambiguous about
        // package.json — but an early version of this fix's own criterion (1)
        // checked only "count of template-owned paths touched === 1" without
        // requiring that one path to BE the path under query, so it also
        // returned `true` for README.md and pnpm-lock.yaml purely because
        // they rode along in the same commit.
        const rootManifest: CoreManifest = {
          version: 1,
          templateOwned: ['package.json'],
          userOwned: ['README.md', 'pnpm-lock.yaml'],
        }
        const diffTreeMixed = (): string => 'package.json\nREADME.md\npnpm-lock.yaml\n'
        const trailerLog =
          '\x02c88e158a\x01' +
          'security(deps): bound the unbounded undici override to <9\n\n' +
          'Core-Divergence: bounds the undici pnpm.overrides entry ahead of\n'

        const gitForPkg = fakeGit({
          log: trailerLog,
          isShallow: 'false',
          diffTree: diffTreeMixed,
        })
        expect(
          pathHasDivergenceTrailerInHistory('/repo', 'package.json', rootManifest, gitForPkg),
        ).toBe(true)

        const gitForReadme = fakeGit({
          log: trailerLog,
          isShallow: 'false',
          diffTree: diffTreeMixed,
        })
        // This is the line that fails without the `templateOwnedTouched[0] ===
        // path` check: README.md is user-owned, was never declared divergent
        // by anything, and must not be laundered through package.json's
        // unrelated, correctly-scoped declaration.
        expect(
          pathHasDivergenceTrailerInHistory('/repo', 'README.md', rootManifest, gitForReadme),
        ).toBe(false)
      },
    )
  })

  describe('#1812 — a shallow graft boundary commit is never trusted as evidence', () => {
    // The shallow-clone artifact: `git log --follow -- <path>` returns the one
    // grafted boundary commit for EVERY path, because git cannot diff it
    // against a parent it does not have locally. Its trailer is about a
    // completely different file.
    const GRAFT_HASH = 'b019272'
    const log =
      `\x02${GRAFT_HASH}\x01` +
      'chore(scripts): drop stale claim/branch-health copies\n\n' +
      'Core-Divergence: dropped claim/branch-health/wait-for-checks.sh (template#1737)\n'

    it('returns false for an unrelated path even though the boundary commit carries a trailer', () => {
      const git = fakeGit({
        log,
        isShallow: 'true',
        graftHashes: GRAFT_HASH,
        diffTree: (hash) => {
          throw new Error(`diff-tree must not be called for a grafted commit, got ${hash}`)
        },
      })
      // .gitignore has never had anything to do with this trailer — the
      // pre-#1812-fix code returns true here purely because the shallow
      // boundary makes `--follow` attribute every path to this one commit.
      expect(pathHasDivergenceTrailerInHistory('/repo', '.gitignore', MANIFEST, git)).toBe(false)
    })

    it('a non-shallow repo with the SAME commit hash and trailer still resolves normally', () => {
      // Proves the exclusion is keyed on shallowness, not merely on ANY
      // parentless commit — a genuine repository-root commit's "touches
      // everything" diff is correct, not an artifact, once `is-shallow-
      // repository` says false. Uses a manifest that actually owns
      // `.gitignore` so criterion (1) (the commit's diff touches exactly one
      // template-owned path) has something to succeed on.
      const gitignoreManifest: CoreManifest = {
        version: 1,
        templateOwned: ['.gitignore'],
        userOwned: [],
      }
      const git = fakeGit({
        log,
        isShallow: 'false',
        diffTree: () => '.gitignore\n',
      })
      expect(pathHasDivergenceTrailerInHistory('/repo', '.gitignore', gitignoreManifest, git)).toBe(
        true,
      )
    })
  })
})

describe('checkOrphanRatchet vs the Core-Divergence TRAILER route (#1718)', () => {
  let base: string
  let ours: string
  let theirs: string

  beforeEach(() => {
    base = makeTmpDir('base')
    ours = makeTmpDir('ours')
    theirs = makeTmpDir('theirs')
  })
  afterEach(() => {
    for (const d of [base, ours, theirs]) rmSync(d, { recursive: true, force: true })
  })

  // Same real shape core-upgrade-orphan-ratchet-divergence.test.ts uses for the
  // config-file route: a real-Postgres CI lane a template-owned gate matches by
  // exact path and name (biffo-platform's actual rls-tests.yml addition, #1602).
  const DIVERGED = '.github/workflows/rls-tests.yml'

  it(
    '(a) a path declared ONLY via a Core-Divergence trailer — no biffo.divergence.json entry — ' +
      'is no longer reported as an orphan',
    async () => {
      initRepo(ours)
      w(ours, DIVERGED, 'name: RLS Tests\n')
      commit(
        ours,
        'infra(ci): add the real-Postgres RLS lane\n\n' +
          'Core-Divergence: template gate matches this exact path and name (#1602)\n',
      )

      // The premise this test depends on: no biffo.divergence.json anywhere,
      // so the config-file route (#1602/#1717) contributes nothing here — if
      // this test passed only because of that route, it would not be testing
      // the trailer at all.
      expect(readDivergenceConfig(ours).warnOnly).toEqual([])

      const plan = await planCoreUpgrade({
        baseDir: base,
        oursDir: ours,
        theirsDir: theirs,
        manifest: MANIFEST,
        mergeFile: neverMerges,
      })

      // The denominator (#1363): how many paths classify() actually examined.
      console.log(
        `core-upgrade-orphan-ratchet-trailer (a): ${plan.entries.length} path(s) examined, ` +
          `1 trailer-declared path under test (${DIVERGED})`,
      )
      expect(plan.entries.length).toBeGreaterThan(0)

      const entry = plan.entries.find((e) => e.path === DIVERGED)
      expect(entry, 'the upgrade should have an opinion about this path').toBeDefined()
      expect(entry?.status).toBe('keep-ours')

      // The line #1718 is about: fails against the unfixed code (orphaned ===
      // true, because isDeclaredDivergent never consulted git history), passes
      // once classify() also asks pathHasDivergenceTrailerInHistory. This
      // commit touches exactly one file, so it is trusted regardless of
      // whether its trailer text names the path (criterion 1).
      expect(entry?.orphaned).not.toBe(true)
      expect(plan.orphaned.map((e) => e.path)).not.toContain(DIVERGED)

      const ratchet = checkOrphanRatchet(plan.orphaned.length, { count: 0 })
      expect(ratchet.increased).toBe(false)
    },
  )

  it('(b) an UNDECLARED orphan in a real git history is still correctly flagged — the ratchet is not defanged', async () => {
    const UNDECLARED = '.github/workflows/some-other-lane.yml'
    initRepo(ours)
    w(ours, UNDECLARED, 'name: Some Other Lane\n')
    // An ordinary commit, deliberately with NO Core-Divergence trailer and no
    // biffo.divergence.json — the negative case this fix must not defeat.
    commit(ours, 'infra(ci): add some other lane\n')
    expect(readDivergenceConfig(ours).warnOnly).toEqual([])

    const plan = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: neverMerges,
    })

    const entry = plan.entries.find((e) => e.path === UNDECLARED)
    expect(entry?.orphaned).toBe(true)
    expect(plan.orphaned.map((e) => e.path)).toContain(UNDECLARED)

    const ratchet = checkOrphanRatchet(plan.orphaned.length, { count: 0 })
    expect(ratchet.increased).toBe(true)
  })

  it(
    'a commit that merely MENTIONS the phrase, without the trailer being its own line, ' +
      'does not launder an undeclared path',
    async () => {
      const LOOKS_LIKE_ONE = '.github/workflows/looks-divergent.yml'
      initRepo(ours)
      w(ours, LOOKS_LIKE_ONE, 'name: Looks Divergent\n')
      commit(ours, 'docs: explain when a Core-Divergence: trailer would be needed here\n')

      const plan = await planCoreUpgrade({
        baseDir: base,
        oursDir: ours,
        theirsDir: theirs,
        manifest: MANIFEST,
        mergeFile: neverMerges,
      })

      const entry = plan.entries.find((e) => e.path === LOOKS_LIKE_ONE)
      expect(entry?.orphaned).toBe(true)
    },
  )

  it('also reaches the sibling "instance deleted a template file" branch via the same closure', async () => {
    // isDeclaredDivergent is the one closure both classify() branches read
    // (see core-upgrade.ts) — proving the trailer route on THIS branch too is
    // what makes "same closure" true rather than aspirational.
    const DELETED_BUT_DECLARED = '.github/workflows/deprecated-lane.yml'
    w(base, DELETED_BUT_DECLARED, 'name: Deprecated Lane\n')
    w(theirs, DELETED_BUT_DECLARED, 'name: Deprecated Lane\n')

    initRepo(ours)
    w(ours, DELETED_BUT_DECLARED, 'name: Deprecated Lane\n')
    commit(ours, 'infra(ci): add deprecated lane placeholder\n')
    rmSync(join(ours, DELETED_BUT_DECLARED))
    commit(
      ours,
      'infra(ci): remove the deprecated lane\n\n' +
        'Core-Divergence: this instance never runs the deprecated lane (#1718 fixture)\n',
    )

    const plan = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: neverMerges,
    })

    const entry = plan.entries.find((e) => e.path === DELETED_BUT_DECLARED)
    // Declared-divergent deletion stays 'removed' rather than being 'restored'
    // (#395) — the same outcome the config-file route already produces, now
    // reachable via the trailer too.
    expect(entry?.status).toBe('removed')
    expect(plan.divergenceSkips).toContain(DELETED_BUT_DECLARED)
  })

  it(
    '#1815 end-to-end: an honest, undeclared deletion co-located in history with an ' +
      'unrelated multi-file Core-Divergence squash is still flagged, not amnestied',
    async () => {
      // Shaped exactly like the issue's own planCoreUpgrade repro: a realistic
      // core-upgrade squash that legitimately declares divergence for
      // package.json ONLY, but also lands core-manifest.json and AGENTS.md in
      // the same commit (as any real core upgrade does) — then, months later,
      // an honest, undeclared deletion of a DIFFERENT template-owned file with
      // no trailer at all.
      initRepo(ours)
      w(ours, 'package.json', '{"name":"instance"}\n')
      w(ours, 'core-manifest.json', '{}\n')
      w(ours, 'AGENTS.md', '# rules\n')
      w(ours, 'eslint.config.mjs', 'export default []\n')
      commit(
        ours,
        'chore(core): upgrade template core 0.204.3 -> 0.249.8\n\n' +
          'Core-Convergence: 3 template-owned files from 0.204.3 to 0.249.7\n' +
          "Core-Divergence: package.json keeps this instance's bounded undici override\n",
      )
      rmSync(join(ours, 'eslint.config.mjs'))
      commit(ours, 'chore: remove eslint config by accident, no trailer here\n')

      const manifest: CoreManifest = {
        version: 1,
        templateOwned: ['package.json', 'core-manifest.json', 'AGENTS.md', 'eslint.config.mjs'],
        userOwned: [],
      }
      w(base, 'eslint.config.mjs', 'export default []\n')
      w(theirs, 'eslint.config.mjs', 'export default []\n')
      w(base, 'package.json', '{"name":"instance","old":true}\n')
      w(theirs, 'package.json', '{"name":"instance","old":true}\n')

      const plan = await planCoreUpgrade({
        baseDir: base,
        oursDir: ours,
        theirsDir: theirs,
        manifest,
        mergeFile: neverMerges,
      })

      // This is the line #1815 proved defanged against the pre-fix code: the
      // pre-fix `isDeclaredDivergent('eslint.config.mjs')` returned `true`
      // purely because the earlier squash commit touched it too, so the
      // undeclared deletion read as an accepted divergence (`status:
      // 'removed'`, listed in `divergenceSkips`) instead of the drift it
      // actually is. Fixed, it must come back as an ordinary restoration —
      // the same outcome an undeclared deletion with no history baggage at
      // all would get.
      const eslintEntry = plan.entries.find((e) => e.path === 'eslint.config.mjs')
      expect(eslintEntry?.status).toBe('restored')
      expect(plan.divergenceSkips).not.toContain('eslint.config.mjs')
    },
  )

  it('#1812 end-to-end: a real --depth 1 clone never reads an unrelated path as declared', async () => {
    initRepo(ours)
    w(ours, DIVERGED, 'name: RLS Tests\n')
    commit(ours, 'infra(ci): add the real-Postgres RLS lane\n')
    w(ours, '.gitignore', 'node_modules/\n')
    commit(
      ours,
      'chore(scripts): drop a stale copy\n\n' +
        'Core-Divergence: dropped claim/branch-health/wait-for-checks.sh (template#1737)\n',
    )

    const shallow = makeTmpDir('biffo-shallow')
    // `file://` forces the transport ("smart") path rather than git's
    // local-clone hardlink optimisation, which silently IGNORES --depth
    // altogether (with only a warning) and would produce a full clone —
    // the opposite of what this test needs to reproduce.
    git(shallow, ['clone', '--quiet', '--depth', '1', `file://${ours}`, '.'])
    expect(git(shallow, ['rev-parse', '--is-shallow-repository']).trim()).toBe('true')

    const plan = await planCoreUpgrade({
      baseDir: base,
      oursDir: shallow,
      theirsDir: theirs,
      manifest: MANIFEST,
      mergeFile: neverMerges,
    })

    // The pre-#1812-fix code returns `true` for EVERY templateOwned path
    // queried against a shallow clone whose tip commit carries any
    // trailer at all — this is the line that proves it no longer does.
    const rlsEntry = plan.entries.find((e) => e.path === DIVERGED)
    expect(rlsEntry?.orphaned).toBe(true)
    expect(plan.orphaned.map((e) => e.path)).toContain(DIVERGED)
  })

  it(
    'cross-guard agreement (#1718 acceptance criterion): checkCoreOwnership accepts the same ' +
      'single-file trailer commit-time that the ratchet now accepts upgrade-time',
    async () => {
      const message =
        'infra(ci): add the real-Postgres RLS lane\n\n' +
        'Core-Divergence: template gate matches this exact path and name (#1602)\n'

      // Commit-time: the guard that actually runs in CI/the pre-push hook.
      const commitTime = checkCoreOwnership({
        changedFiles: [DIVERGED],
        manifest: MANIFEST,
        isInstance: true,
        commitMessage: message,
      })
      expect(commitTime.skipped).toBe('divergence-trailer')
      expect(commitTime.blocked).toEqual([])

      // Upgrade-time: the same commit, the same trailer, read by the ratchet.
      initRepo(ours)
      w(ours, DIVERGED, 'name: RLS Tests\n')
      commit(ours, message)

      const plan = await planCoreUpgrade({
        baseDir: base,
        oursDir: ours,
        theirsDir: theirs,
        manifest: MANIFEST,
        mergeFile: neverMerges,
      })
      const entry = plan.entries.find((e) => e.path === DIVERGED)
      expect(entry?.orphaned).not.toBe(true)

      // Agreement: neither guard blocks/flags a path the other one accepts.
      expect(commitTime.blocked).toEqual([])
      expect(plan.orphaned.map((e) => e.path)).not.toContain(DIVERGED)
    },
  )
})
