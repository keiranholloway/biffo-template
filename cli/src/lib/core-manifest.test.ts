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

describe('real repo core-manifest.json', () => {
  it('parses and classifies core vs user paths as expected', () => {
    const manifest = readCoreManifest(repoRoot)
    expect(manifest.version).toBe(1)
    expect(isTemplateOwned('services/api/src/api/main.py', manifest)).toBe(true)
    expect(isTemplateOwned('services/acme-crm/biffo.plugin.json', manifest)).toBe(false)
    expect(isTemplateOwned('infra/environments/dev/main.tf', manifest)).toBe(false)
    expect(isTemplateOwned('biffo.core.json', manifest)).toBe(false)
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

  it('owns the two hooks it wires, but not the .husky/ directory (#370)', () => {
    const manifest = readCoreManifest(repoRoot)
    // The template wires commitlint, lint-staged and the core-ownership guard,
    // so those two files must reach instances — a guard that stays in the repo
    // that does not need it guards nothing.
    expect(isTemplateOwned('.husky/commit-msg', manifest)).toBe(true)
    expect(isTemplateOwned('.husky/pre-commit', manifest)).toBe(true)
    // ...but a hook the INSTANCE adds is its own. Owning the directory would
    // make an upgrade propose deleting it — the #279 part-1 trap.
    expect(isTemplateOwned('.husky/pre-push', manifest)).toBe(false)
    expect(isTemplateOwned('.husky/post-merge', manifest)).toBe(false)
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
    // removed (in instance, not template)
    write(instance, 'services/api/gone.py', 'obsolete')
    // user-owned differences are ignored entirely
    write(template, 'services/acme-crm/a.json', '1')
    write(instance, 'services/acme-crm/a.json', '2')

    const diff = computeCoreDiff(template, instance, MANIFEST)
    expect(diff.modified).toEqual(['services/api/main.py'])
    expect(diff.added).toEqual(['services/api/new_file.py'])
    expect(diff.removed).toEqual(['services/api/gone.py'])
    expect(diff.unchanged).toBe(1)
  })
})
