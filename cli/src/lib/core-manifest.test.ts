import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CORE_MANIFEST_FILE,
  type CoreManifest,
  computeCoreDiff,
  findTemplateRoot,
  isTemplateOwned,
  listTemplateOwnedFiles,
  readCoreManifest,
  resolveTemplateRoot,
} from './core-manifest.js'
import { isInstanceRepo } from './core-version.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const MANIFEST: CoreManifest = {
  version: 1,
  templateOwned: ['services/api/', 'modules/', 'core.version', 'package.json'],
  userOwned: ['services/', 'infra/', 'README.md'],
}

describe('isTemplateOwned (longest-prefix, tie -> user)', () => {
  it('matches a template directory subtree', () => {
    expect(isTemplateOwned('services/api/src/main.py', MANIFEST)).toBe(true)
    expect(isTemplateOwned('modules/cloud/aws/main.tf', MANIFEST)).toBe(true)
  })
  it('matches an exact template file', () => {
    expect(isTemplateOwned('core.version', MANIFEST)).toBe(true)
    expect(isTemplateOwned('package.json', MANIFEST)).toBe(true)
  })
  it('a more specific template prefix beats a broad user prefix', () => {
    // services/ is userOwned, but services/api/ is a longer templateOwned prefix
    expect(isTemplateOwned('services/api/src/x.py', MANIFEST)).toBe(true)
  })
  it('a user subtree under no more-specific template prefix is user-owned', () => {
    expect(isTemplateOwned('services/acme-crm/biffo.plugin.json', MANIFEST)).toBe(false)
    expect(isTemplateOwned('infra/environments/dev/main.tf', MANIFEST)).toBe(false)
    expect(isTemplateOwned('README.md', MANIFEST)).toBe(false)
  })
  it('an unlisted path is not template-owned', () => {
    expect(isTemplateOwned('apps/portal/page.tsx', MANIFEST)).toBe(false)
  })
})

/**
 * Glob entries and how they rank (issue #755). A glob scores its literal
 * characters — pattern length minus its `*`s — because a `*` matches unbounded
 * text and asserts nothing about the path. The ordering these tests pin down is
 * the part that silently changes ownership if it is got wrong.
 */
describe('isTemplateOwned (glob entries, #755)', () => {
  const GLOBBED: CoreManifest = {
    version: 1,
    templateOwned: ['.github/', '.github/workflows/ci.instance.yml'],
    userOwned: ['.github/workflows/*.instance.yml'],
    released: [],
  }

  it('a glob beats the prefix that contains it', () => {
    // `.github/workflows/*.instance.yml` scores 31 literals; `.github/` scores 8.
    expect(isTemplateOwned('.github/workflows/foo.instance.yml', GLOBBED)).toBe(false)
    expect(isTemplateOwned('.github/workflows/ci.yml', GLOBBED)).toBe(true)
    expect(isTemplateOwned('.github/dependabot.yml', GLOBBED)).toBe(true)
  })

  it('an exact-file entry never loses to a glob', () => {
    // A glob matching path P has at most P.length literals, so an exact entry
    // for P ties at worst — and the template side wins outright when it is
    // strictly longer. The template can always pin one named file back.
    expect(isTemplateOwned('.github/workflows/ci.instance.yml', GLOBBED)).toBe(true)
  })

  it('a tie between a glob and an exact entry still goes to user-owned', () => {
    // A tie is reachable only when the `*` matches the empty string:
    // `.github/xy*.yml` and `.github/xy.yml` both score 14 on `.github/xy.yml`.
    // The fail-closed tie rule is unchanged by globs.
    const tied: CoreManifest = {
      version: 1,
      templateOwned: ['.github/xy*.yml'],
      userOwned: ['.github/xy.yml'],
      released: [],
    }
    expect(isTemplateOwned('.github/xy.yml', tied)).toBe(false)
  })

  it('a more specific glob outranks a broader one', () => {
    const layered: CoreManifest = {
      version: 1,
      templateOwned: ['.github/workflows/*.yml'],
      userOwned: ['.github/workflows/*.instance.yml'],
      released: [],
    }
    expect(isTemplateOwned('.github/workflows/ci.yml', layered)).toBe(true)
    expect(isTemplateOwned('.github/workflows/db.instance.yml', layered)).toBe(false)
  })

  it('* never crosses a path separator', () => {
    // Narrower on purpose: a glob that spanned `/` would carve out paths nobody
    // was thinking about, and everything it fails to match stays template-owned
    // — the direction that blocks rather than the direction that widens.
    expect(isTemplateOwned('.github/workflows/nested/foo.instance.yml', GLOBBED)).toBe(true)
  })

  it('treats regex metacharacters in a pattern as literals', () => {
    const dotted: CoreManifest = {
      version: 1,
      templateOwned: ['.github/'],
      userOwned: ['.github/a.b*.yml'],
      released: [],
    }
    expect(isTemplateOwned('.github/a.bc.yml', dotted)).toBe(false)
    expect(isTemplateOwned('.github/axbc.yml', dotted)).toBe(true)
  })

  it('leaves non-glob entries scoring exactly as before', () => {
    // Regression fence: adding globs must not shift prefix/exact ranking.
    expect(isTemplateOwned('services/api/src/x.py', MANIFEST)).toBe(true)
    expect(isTemplateOwned('services/acme-crm/x.json', MANIFEST)).toBe(false)
  })
})

/**
 * `**` as a subtree glob (issue #1026): the one place `*` is allowed to cross
 * a `/`, and only when it is a whole segment on its own. Exists so a carve-out
 * like `modules/**\/instance/` can name "an `instance/` directory, however
 * deep under modules/" — `modules/` nests provider/module subtrees to an
 * unpredictable depth, so a single-segment `*` cannot express it the way it
 * expresses "a `*.yml` file in one known directory" (#755's glob).
 */
describe('isTemplateOwned (** subtree glob, #1026)', () => {
  const DEEP: CoreManifest = {
    version: 1,
    templateOwned: ['modules/'],
    userOwned: ['modules/**/instance/'],
    released: [],
  }

  it('matches an instance/ directory at any depth under the fixed prefix', () => {
    expect(isTemplateOwned('modules/cloud/aws/networking/instance/test_foo.tf', DEEP)).toBe(false)
    expect(isTemplateOwned('modules/source-control/github/instance/x.tf', DEEP)).toBe(false)
    // Deeper still — ** has no fixed depth.
    expect(isTemplateOwned('modules/a/b/c/d/instance/x.tf', DEEP)).toBe(false)
  })

  it('matches with zero segments between the fixed prefix and the carve-out', () => {
    expect(isTemplateOwned('modules/instance/x.tf', DEEP)).toBe(false)
  })

  it('does not match a directory that merely contains "instance" as a substring', () => {
    // A directory named instance-utils is not an instance/ directory — the
    // segment must match exactly, the same discipline a plain prefix entry
    // already has (services/api/ does not match services/api-gateway/).
    expect(isTemplateOwned('modules/cloud/aws/instance-utils/x.tf', DEEP)).toBe(true)
  })

  it('everything else under modules/ stays template-owned', () => {
    expect(isTemplateOwned('modules/cloud/aws/networking/main.tf', DEEP)).toBe(true)
    expect(
      isTemplateOwned('modules/cloud/aws/networking/tests/nat_instance.tftest.hcl', DEEP),
    ).toBe(true)
  })

  it('a lone * elsewhere in the same manifest is still segment-local', () => {
    // Regression fence: adding ** support must not widen plain *.
    const mixed: CoreManifest = {
      version: 1,
      templateOwned: ['.github/'],
      userOwned: ['.github/workflows/*.instance.yml', 'modules/**/instance/'],
      released: [],
    }
    expect(isTemplateOwned('.github/workflows/nested/foo.instance.yml', mixed)).toBe(true)
  })
})

describe('real repo core-manifest.json', () => {
  it('parses and classifies core vs user paths as expected', () => {
    const manifest = readCoreManifest(repoRoot)
    expect(manifest.version).toBe(1)
    expect(isTemplateOwned('services/api/src/api/main.py', manifest)).toBe(true)
    expect(isTemplateOwned('services/acme-crm/biffo.plugin.json', manifest)).toBe(false)
    expect(isTemplateOwned('infra/environments/dev/main.tf', manifest)).toBe(false)
    expect(isTemplateOwned('biffo.core.json', manifest)).toBe(false)
  })

  it('owns .gitleaks.toml so Secret Scan rules + allowlists distribute to instances (#516)', () => {
    const manifest = readCoreManifest(repoRoot)
    // The template ships the scan rules and the code they must not flag, so it
    // must be able to ship the allowlist that keeps them consistent (#514/#516).
    // Exact file, like the .husky hooks (#370) and .prettierignore.
    expect(isTemplateOwned('.gitleaks.toml', manifest)).toBe(true)
    // Still an exact-file grant, not a root-wide one — a sibling root config a
    // user might add stays their own.
    expect(isTemplateOwned('.env', manifest)).toBe(false)
  })

  it('carves out .github/workflows/*.instance.yml so an instance can add its own CI (#755)', () => {
    const manifest = readCoreManifest(repoRoot)
    // `.github/` is template-owned wholesale, which left an instance unable to
    // add a lane testing something only that instance has (a DDL-import, a
    // sibling, its own deploy shape). Such a workflow has no template
    // counterpart, so `Core-Divergence:` — "this instance must differ from a
    // template file" — was the wrong instrument, and every use of it added a
    // ledger entry that can never converge.
    expect(isTemplateOwned('.github/workflows/db-tests.instance.yml', manifest)).toBe(false)

    // ...and the carve-out is exactly that suffix, in exactly that directory.
    // Everything else under .github/ stays template-owned, including every
    // workflow the template ships: a carve-out that accidentally widens is the
    // real risk, so pin the boundary rather than the one happy path.
    expect(isTemplateOwned('.github/workflows/ci.yml', manifest)).toBe(true)
    expect(isTemplateOwned('.github/workflows/deploy-app.yml', manifest)).toBe(true)
    expect(isTemplateOwned('.github/workflows/instance.yml', manifest)).toBe(true)
    expect(isTemplateOwned('.github/workflows/db-tests.instance.yaml', manifest)).toBe(true)
    expect(isTemplateOwned('.github/workflows/nested/x.instance.yml', manifest)).toBe(true)
    expect(isTemplateOwned('.github/dependabot.yml', manifest)).toBe(true)
    expect(isTemplateOwned('.github/actions/setup/action.yml', manifest)).toBe(true)
    expect(isTemplateOwned('.github/CODEOWNERS', manifest)).toBe(true)
    expect(isTemplateOwned('.github/x.instance.yml', manifest)).toBe(true)
  })

  it('was template-owned before the carve-out, which is the whole defect (#755)', () => {
    // The failing state, reconstructed from the live manifest by dropping the
    // one entry that fixes it: without the glob, an instance-authored workflow
    // resolves template-owned and the ownership guard refuses the commit.
    const manifest = readCoreManifest(repoRoot)
    const before: CoreManifest = {
      ...manifest,
      userOwned: manifest.userOwned.filter((p) => !p.includes('*.instance.yml')),
    }
    expect(before.userOwned.length).toBe(manifest.userOwned.length - 1)
    expect(isTemplateOwned('.github/workflows/db-tests.instance.yml', before)).toBe(true)
    // ci.yml is template-owned on both sides — the carve-out moved one path, not the directory.
    expect(isTemplateOwned('.github/workflows/ci.yml', before)).toBe(true)
  })

  it('the template itself ships no *.instance.yml, so there is nothing to collide with (#755)', () => {
    // The carve-out's premise. A template-shipped `*.instance.yml` would be a
    // file the template maintains but can never distribute — it resolves
    // user-owned, so `biffo core upgrade` would not carry it and every instance
    // would silently miss it (the #243/#325 failure mode).
    const tracked = execFileSync('git', ['ls-files', '--', '*.instance.yml'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
    expect(tracked).toEqual([])
  })

  it('carves out services/_plugins/ so first-party plugins are carried by core upgrade', () => {
    const manifest = readCoreManifest(repoRoot)
    // A first-party plugin lives in the template-owned carve-out, so
    // `biffo core upgrade` distributes it instead of fail-closing on it (#243).
    expect(isTemplateOwned('services/_plugins/orchestrator/biffo.plugin.json', manifest)).toBe(true)
    expect(
      isTemplateOwned('services/_plugins/orchestrator/src/orchestrator/plugin.py', manifest),
    ).toBe(true)
    expect(isTemplateOwned('services/_plugins/orchestrator/terraform/main.tf', manifest)).toBe(true)
    // ...while a third-party/user plugin under the user-owned services/ is
    // never overwritten by an upgrade. Where it lives is what decides.
    expect(isTemplateOwned('services/foo/biffo.plugin.json', manifest)).toBe(false)
    expect(isTemplateOwned('services/acme-crm/terraform/main.tf', manifest)).toBe(false)
  })

  it('carves out services/api/tests/instance/ and modules/**/instance/ as a home for instance-written tests (#1026)', () => {
    const manifest = readCoreManifest(repoRoot)
    // A test the instance itself writes has a sanctioned home now, instead of
    // resolving template-owned and showing up as unsanctioned drift on every
    // `biffo core upgrade`.
    expect(isTemplateOwned('services/api/tests/instance/test_tabsii_router.py', manifest)).toBe(
      false,
    )
    expect(isTemplateOwned('modules/cloud/aws/networking/instance/main.tf', manifest)).toBe(false)
    expect(isTemplateOwned('modules/instance/main.tf', manifest)).toBe(false)
    // A test the TEMPLATE ships stays template-owned — the carve-out is the
    // instance/ subdirectory, not the whole tests/ tree.
    expect(isTemplateOwned('services/api/tests/test_ddl_import.py', manifest)).toBe(true)
    expect(
      isTemplateOwned('modules/cloud/aws/networking/tests/nat_instance.tftest.hcl', manifest),
    ).toBe(true)
  })

  it('carves out migrations/versions (append-only per-instance chain) but keeps the framework', () => {
    const manifest = readCoreManifest(repoRoot)
    // Instance-accumulated migration files must NOT be synced from the template.
    expect(
      isTemplateOwned('services/api/migrations/versions/0001_create_users_table.py', manifest),
    ).toBe(false)
    // ...but the migration framework files stay template-owned.
    expect(isTemplateOwned('services/api/migrations/env.py', manifest)).toBe(true)
    expect(isTemplateOwned('services/api/migrations/script.py.mako', manifest)).toBe(true)
  })

  it('does not own core.version, so an upgrade never overwrites an instance copy', () => {
    const manifest = readCoreManifest(repoRoot)
    // core.version is the version the *template emits*; the version an instance
    // *received* lives in biffo.core.json, which wins on every read. Syncing
    // core.version into an instance can only overwrite (an instance may keep its
    // own release lineage there) — so it is neither template-owned nor synced.
    expect(isTemplateOwned('core.version', manifest)).toBe(false)
    expect(manifest.templateOwned).not.toContain('core.version')
  })

  it('owns the hooks it wires, but not the hooks directory (#370, #374, #838)', () => {
    const manifest = readCoreManifest(repoRoot)
    // The template wires commitlint, lint-staged, the core-ownership guard and
    // (since #374) the pre-push verify gate, so those files must reach
    // instances — a guard that stays in the repo that does not need it guards
    // nothing.
    expect(isTemplateOwned('.githooks/commit-msg', manifest)).toBe(true)
    expect(isTemplateOwned('.githooks/pre-commit', manifest)).toBe(true)
    expect(isTemplateOwned('.githooks/pre-push', manifest)).toBe(true)
    // The .husky/ forwarders are owned too, for as long as they exist: a clone
    // whose core.hooksPath still points at .husky/_ runs them, and an upgrade
    // that carried the new hooks but not the forwarders would leave that clone
    // executing the OLD hooks against the new tree.
    expect(isTemplateOwned('.husky/pre-push', manifest)).toBe(true)
    // ...but a hook the INSTANCE adds is its own. Owning the directory would
    // make an upgrade propose deleting it — the #279 part-1 trap. Each wired
    // hook is an EXACT-file entry; an unwired one stays the instance's.
    expect(isTemplateOwned('.githooks/post-merge', manifest)).toBe(false)
    expect(isTemplateOwned('.husky/post-merge', manifest)).toBe(false)
    expect(manifest.templateOwned).not.toContain('.githooks/')
    expect(manifest.templateOwned).not.toContain('.husky/')
  })

  it('leaves biffo.divergence.json user-owned, or the guard would block its own config', () => {
    const manifest = readCoreManifest(repoRoot)
    // Which template-owned prefixes an instance knowingly diverges in is
    // per-instance policy. Were it template-owned, recording a divergence would
    // be refused by the guard it configures.
    expect(isTemplateOwned('biffo.divergence.json', manifest)).toBe(false)
  })

  it.skipIf(isInstanceRepo(repoRoot))(
    'findTemplateRoot locates the repo root from a nested dir',
    () => {
      // Template-only: it asserts over THIS repo's layout. An instance root
      // carries biffo.core.json, so it is deliberately not a template root
      // (see below) and the walk correctly leaves the repo entirely (#367).
      expect(findTemplateRoot(here)).toBe(repoRoot)
    },
  )

  /**
   * The instance/template discriminator, tested on synthetic trees so it runs
   * in both repos rather than only the one whose layout happens to match.
   *
   * An instance carries a core-manifest.json too — it is template-owned and
   * distributed — so presence alone would resolve the instance the CLI is
   * installed into as its own upgrade source, and `biffo core upgrade` would
   * three-way merge a tree against itself and report nothing to do.
   */
  it('rejects an instance root, which also carries a core-manifest.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biffo-root-'))
    try {
      writeFileSync(join(dir, CORE_MANIFEST_FILE), JSON.stringify({ version: 1 }))
      expect(findTemplateRoot(dir)).toBe(dir)

      writeFileSync(join(dir, 'biffo.core.json'), JSON.stringify({ version: '0.1.0' }))
      expect(findTemplateRoot(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveTemplateRoot appends caller guidance verbatim when no root is found', () => {
    // A tmp dir has no core-manifest.json / core.version above it, so the walk
    // fails and the command-specific remedy (issue #324) must reach the user.
    const noRoot = mkdtempSync(join(tmpdir(), 'biffo-noroot-'))
    try {
      expect(() =>
        resolveTemplateRoot({ fromDir: noRoot, guidance: 'Pass --template-repo <path>.' }),
      ).toThrow(/Could not locate a Biffo template root.*Pass --template-repo <path>\./s)
    } finally {
      rmSync(noRoot, { recursive: true, force: true })
    }
  })
})

describe('listTemplateOwnedFiles + computeCoreDiff', () => {
  let template: string
  let instance: string

  beforeEach(() => {
    template = mkdtempSync(join(tmpdir(), 'biffo-tmpl-'))
    instance = mkdtempSync(join(tmpdir(), 'biffo-inst-'))
  })
  afterEach(() => {
    rmSync(template, { recursive: true, force: true })
    rmSync(instance, { recursive: true, force: true })
  })

  function write(root: string, rel: string, content: string): void {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }

  it('lists only template-owned files and skips excluded dirs', () => {
    write(template, 'services/api/main.py', 'x')
    write(template, 'services/acme-crm/plugin.json', 'y') // user-owned
    write(template, 'node_modules/foo/index.js', 'z') // hard-excluded
    const files = listTemplateOwnedFiles(template, MANIFEST)
    expect(files).toEqual(['services/api/main.py'])
  })

  it('trackedOnly drops gitignored and untracked files inside a template-owned prefix (#1006)', () => {
    execFileSync('git', ['-C', template, 'init', '--quiet'], { stdio: 'ignore' })
    write(template, '.gitignore', '*.tsbuildinfo\n')
    write(template, 'services/api/main.py', 'x')
    execFileSync('git', ['-C', template, 'add', '-A'], { stdio: 'ignore' })
    // Left behind by a local build and by an editor scratch file respectively.
    write(template, 'services/api/tsconfig.tsbuildinfo', 'BUILD ARTIFACT')
    write(template, 'services/api/scratch.py', 'never committed')

    expect(listTemplateOwnedFiles(template, MANIFEST, { trackedOnly: true })).toEqual([
      'services/api/main.py',
    ])
    // Without the flag the listing is whatever is on disk — which is right for
    // an instance's own working tree, and wrong for a template at a version.
    expect(listTemplateOwnedFiles(template, MANIFEST)).toEqual([
      'services/api/main.py',
      'services/api/scratch.py',
      'services/api/tsconfig.tsbuildinfo',
    ])
  })

  it('computeCoreDiff does not report a gitignored template artifact as added (#1006)', () => {
    execFileSync('git', ['-C', template, 'init', '--quiet'], { stdio: 'ignore' })
    write(template, '.gitignore', '*.tsbuildinfo\n')
    write(template, 'services/api/main.py', 'x')
    execFileSync('git', ['-C', template, 'add', '-A'], { stdio: 'ignore' })
    write(template, 'services/api/tsconfig.tsbuildinfo', 'BUILD ARTIFACT')
    write(instance, 'services/api/main.py', 'x')

    const diff = computeCoreDiff(template, instance, MANIFEST)
    expect(diff.added).toEqual([])
    expect(diff.unchanged).toBe(1)
  })

  it('never descends into .terraform (a terraform init leaves huge provider binaries there)', () => {
    write(template, 'modules/cloud/aws/main.tf', 'resource {}')
    // A provider binary under a template-owned path — must be skipped, not read.
    write(template, 'modules/cloud/aws/.terraform/providers/registry/aws_v5', 'BINARY')
    const files = listTemplateOwnedFiles(template, MANIFEST)
    expect(files).toEqual(['modules/cloud/aws/main.tf'])
  })

  it('classifies added / removed / modified / unchanged from the instance perspective', () => {
    // unchanged
    write(template, 'core.version', '0.2.0\n')
    write(instance, 'core.version', '0.2.0\n')
    // modified
    write(template, 'services/api/main.py', 'new')
    write(instance, 'services/api/main.py', 'old')
    // added (in template, not instance)
    write(template, 'services/api/new_file.py', 'brand new')
    // instance-only (in instance, never in template) — NOT a removal (#689)
    write(instance, 'services/api/gone.py', 'obsolete')
    // user-owned differences are ignored entirely
    write(template, 'services/acme-crm/a.json', '1')
    write(instance, 'services/acme-crm/a.json', '2')

    const diff = computeCoreDiff(template, instance, MANIFEST)
    expect(diff.modified).toEqual(['services/api/main.py'])
    expect(diff.added).toEqual(['services/api/new_file.py'])
    // With no merge base, "absent from the template" cannot mean "the template
    // dropped it" — so it is instance-only, never a pending deletion (#689).
    expect(diff.instanceOnly).toEqual(['services/api/gone.py'])
    expect(diff.removed).toEqual([])
    expect(diff.unchanged).toBe(1)
  })

  it('distinguishes an upstream removal from an instance addition, given a base (#689)', () => {
    const base = mkdtempSync(join(tmpdir(), 'biffo-base-'))
    // The template shipped this and later dropped it -> an upgrade DELETES it.
    write(base, 'services/api/retired.py', 'old core file')
    write(instance, 'services/api/retired.py', 'old core file')
    // The instance authored this; the template never had it -> upgrade leaves it.
    write(instance, 'services/api/ours.py', 'instance feature')
    write(template, 'services/api/kept.py', 'still shipped')
    write(instance, 'services/api/kept.py', 'still shipped')

    const diff = computeCoreDiff(template, instance, MANIFEST, base)

    expect(diff.removed).toEqual(['services/api/retired.py'])
    expect(diff.instanceOnly).toEqual(['services/api/ours.py'])
  })

  it('never reports an instance-authored file as removed (#689 regression)', () => {
    // The exact shape that halted a deploy: files an instance wrote inside a
    // template-owned tree, reported as `removed` and read as imminent data loss.
    write(instance, 'services/api/tables/__init__.py', '# instance-authored')
    write(instance, 'services/api/tests/test_require_approved.py', 'def test(): pass')

    const diff = computeCoreDiff(template, instance, MANIFEST)

    expect(diff.removed).toEqual([])
    expect(diff.instanceOnly).toHaveLength(2)
  })
})
