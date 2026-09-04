import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_NAME_PATTERN,
  STANDALONE_ONLY_ENTRIES,
  deriveNames,
  findSkeletonRoot,
  scaffoldPlugin,
} from './plugin-scaffold.js'
import { makeTmpDir } from '../test-utils/tmp.js'

let root: string

beforeEach(() => {
  root = makeTmpDir('plugin-scaffold')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const abs = join(root, relPath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, contents)
}

/**
 * A miniature stand-in for `_skeletons/plugin-template/`, carrying the same
 * shape the real one does: an `example_plugin` package, an `example-plugin`
 * manifest, a `terraform/` module, and the standalone-repo-only entries that
 * must be dropped.
 */
function makeSkeleton(): string {
  const skeleton = join(root, 'skeleton')
  write('skeleton/biffo.plugin.json', JSON.stringify({ name: 'example-plugin' }))
  write('skeleton/pyproject.toml', 'name = "biffo-plugin-example"\n')
  write('skeleton/src/example_plugin/plugin.py', 'class ExamplePlugin:\n    pass\n')
  write('skeleton/tests/test_example_plugin.py', 'from example_plugin import ExamplePlugin\n')
  write('skeleton/terraform/main.tf', 'module "plugin" { name = "example-plugin" }\n')
  write('skeleton/terraform/variables.tf', 'variable "plugin_name" {}\n')
  write('skeleton/.github/workflows/ci.yml', 'name: ci\n')
  write('skeleton/registry-schema.json', '{}\n')
  write('skeleton/node_modules/dep/index.js', 'module.exports = 1\n')
  write('skeleton/__pycache__/x.pyc', 'junk')
  write('skeleton/uv.lock', 'version = 1\nrequires-python = ">=3.13"\n')
  return skeleton
}

describe('deriveNames', () => {
  it('derives every naming variant from the slug', () => {
    expect(deriveNames('acme-crm')).toEqual({
      slug: 'acme-crm',
      pkg: 'acme_crm',
      pascal: 'AcmeCrm',
      dist: 'biffo-plugin-acme-crm',
    })
  })

  it('handles a single-word slug', () => {
    expect(deriveNames('billing')).toMatchObject({ pkg: 'billing', pascal: 'Billing' })
  })

  it.each(['Acme-CRM', '1crm', 'acme_crm', 'acme crm', '-crm', ''])(
    'rejects the invalid slug %o',
    (slug) => {
      expect(() => deriveNames(slug)).toThrow('Invalid plugin name')
      expect(PLUGIN_NAME_PATTERN.test(slug)).toBe(false)
    },
  )
})

describe('scaffoldPlugin', () => {
  it('renames the example plugin throughout paths and contents', () => {
    const dest = join(root, 'out')
    const result = scaffoldPlugin(makeSkeleton(), dest, deriveNames('acme-crm'))

    expect(result.files).toContain('src/acme_crm/plugin.py')
    expect(result.files).toContain('tests/test_acme_crm.py')
    expect(readFileSync(join(dest, 'src/acme_crm/plugin.py'), 'utf8')).toContain(
      'class AcmeCrmPlugin',
    )
    expect(readFileSync(join(dest, 'pyproject.toml'), 'utf8')).toContain('biffo-plugin-acme-crm')
    expect(JSON.parse(readFileSync(join(dest, 'biffo.plugin.json'), 'utf8'))).toEqual({
      name: 'acme-crm',
    })
  })

  it('namespaces the example table so two scaffolded plugins cannot collide', () => {
    const dest = join(root, 'out')
    write('skeleton/biffo.plugin.json', JSON.stringify({ name: 'example-plugin' }))
    const skeleton = makeSkeleton()
    write(
      'skeleton/biffo.plugin.json',
      JSON.stringify({ name: 'example-plugin', tables: [{ name: 'example_widgets' }] }),
    )
    scaffoldPlugin(skeleton, dest, deriveNames('acme-crm'))

    expect(JSON.parse(readFileSync(join(dest, 'biffo.plugin.json'), 'utf8')).tables).toEqual([
      { name: 'acme_crm_widgets' },
    ])
  })

  // Issue #194 / PR #262: a plugin that declares event subscriptions but ships
  // no terraform/ has no Lambda and no EventBridge rule, so its subscriptions
  // are inert everywhere and nothing reports it.
  it('always carries terraform/ into the scaffolded plugin', () => {
    const dest = join(root, 'out')
    const result = scaffoldPlugin(makeSkeleton(), dest, deriveNames('acme-crm'))

    expect(result.files).toEqual(
      expect.arrayContaining(['terraform/main.tf', 'terraform/variables.tf']),
    )
    expect(existsSync(join(dest, 'terraform', 'main.tf'))).toBe(true)
    expect(readFileSync(join(dest, 'terraform', 'main.tf'), 'utf8')).toContain('"acme-crm"')
  })

  it('refuses to scaffold from a skeleton that has no terraform/', () => {
    const skeleton = makeSkeleton()
    rmSync(join(skeleton, 'terraform'), { recursive: true })

    expect(() => scaffoldPlugin(skeleton, join(root, 'out'), deriveNames('acme-crm'))).toThrow(
      /no terraform\/ directory/,
    )
  })

  it('drops standalone-repo-only entries, with a reason for each', () => {
    const dest = join(root, 'out')
    const result = scaffoldPlugin(makeSkeleton(), dest, deriveNames('acme-crm'))

    expect(result.skipped.map((s) => s.entry).sort()).toEqual(
      Object.keys(STANDALONE_ONLY_ENTRIES).sort(),
    )
    for (const { reason } of result.skipped) expect(reason).not.toHaveLength(0)
    expect(existsSync(join(dest, '.github'))).toBe(false)
    expect(existsSync(join(dest, 'registry-schema.json'))).toBe(false)
  })

  it('defaults to the in-tree layout when no options are passed', () => {
    // The 4th argument is optional so existing callers keep the monorepo
    // behaviour; a standalone scaffold must be asked for explicitly.
    const dest = join(root, 'out')
    const result = scaffoldPlugin(makeSkeleton(), dest, deriveNames('acme-crm'), {})

    expect(result.skipped.map((s) => s.entry).sort()).toEqual(
      Object.keys(STANDALONE_ONLY_ENTRIES).sort(),
    )
  })

  it('keeps the standalone-repo-only entries for the standalone layout', () => {
    // ADR-0003 §2: a plugin lives in its own repository with a standardised
    // layout that includes .github/workflows/ — an independent CI/CD pipeline.
    // Dropping them here is what left the skeleton's workflows undeliverable
    // by any command (#803).
    const dest = join(root, 'out')
    const result = scaffoldPlugin(makeSkeleton(), dest, deriveNames('acme-crm'), {
      layout: 'standalone',
    })

    expect(result.skipped).toEqual([])
    expect(existsSync(join(dest, '.github/workflows/ci.yml'))).toBe(true)
    expect(existsSync(join(dest, 'registry-schema.json'))).toBe(true)
    expect(result.files).toContain('.github/workflows/ci.yml')
    expect(result.files).toContain('registry-schema.json')
  })

  it('still renames the plugin, and still skips detritus, in the standalone layout', () => {
    // The layout decides which top-level entries survive — nothing else. A
    // standalone scaffold that shipped node_modules or an unrenamed package
    // would be a different bug wearing the same flag.
    const dest = join(root, 'out')
    const result = scaffoldPlugin(makeSkeleton(), dest, deriveNames('acme-crm'), {
      layout: 'standalone',
    })

    expect(result.files).toContain('src/acme_crm/plugin.py')
    expect(existsSync(join(dest, 'node_modules'))).toBe(false)
    expect(existsSync(join(dest, '__pycache__'))).toBe(false)
  })

  it('never copies build or VCS detritus', () => {
    const dest = join(root, 'out')
    scaffoldPlugin(makeSkeleton(), dest, deriveNames('acme-crm'))

    expect(existsSync(join(dest, 'node_modules'))).toBe(false)
    expect(existsSync(join(dest, '__pycache__'))).toBe(false)
  })

  // Regression guard for biffo-template#1731 item 3: `uv.lock` must stay in
  // NEVER_COPY. The skeleton's uv.lock resolves and pins `example-plugin`'s
  // OWN dependency set under the skeleton's OWN package name — if it were
  // ever copied into a scaffolded plugin, the plugin would inherit a
  // lockfile naming a different package (still `biffo-plugin-example`, not
  // its own `dist` name from ScaffoldNames) and pinning resolutions for
  // dependencies the scaffolded plugin may not even declare once
  // `applySubstitutions` has rewritten pyproject.toml. `uv sync --locked`
  // (added by PR #1760/#1762 to every scaffolded skeleton's own CI, per
  // this same issue) would then fail immediately in a freshly-created
  // plugin repo it had never resolved anything for, or — worse — silently
  // pin stale/wrong transitive versions if it happened to still resolve.
  //
  // This is asserted against scaffoldPlugin's actual output (the file is
  // absent from both the returned file list AND the destination directory),
  // not by reading the NEVER_COPY Set directly, so it fails if the set is
  // edited OR if the copy logic stops consulting it correctly.
  it('never copies the skeleton uv.lock (regression guard for #1731)', () => {
    const dest = join(root, 'out-uv-lock')
    const result = scaffoldPlugin(makeSkeleton(), dest, deriveNames('acme-crm'))

    expect(existsSync(join(dest, 'uv.lock'))).toBe(false)
    expect(result.files).not.toContain('uv.lock')
  })

  it('throws when the skeleton does not exist', () => {
    expect(() =>
      scaffoldPlugin(join(root, 'nope'), join(root, 'out'), deriveNames('acme-crm')),
    ).toThrow('Plugin skeleton not found')
  })
})

describe('findSkeletonRoot', () => {
  it('walks up to the nearest _skeletons/<name>', () => {
    write('_skeletons/plugin-template/biffo.plugin.json', '{}')
    mkdirSync(join(root, 'cli', 'dist', 'nested'), { recursive: true })

    expect(findSkeletonRoot(join(root, 'cli', 'dist', 'nested'), 'plugin-template')).toBe(
      join(root, '_skeletons', 'plugin-template'),
    )
  })

  it('returns null when there is no skeleton above the start directory', () => {
    expect(findSkeletonRoot(root, 'definitely-not-a-skeleton')).toBeNull()
  })
})

describe('the real _skeletons/plugin-template', () => {
  // Guards the scaffolder against the *actual* skeleton drifting away from the
  // token vocabulary substitutions() knows about — a rename in the skeleton
  // would otherwise silently produce a plugin still called "example-plugin".
  const realSkeleton = findSkeletonRoot(new URL('.', import.meta.url).pathname, 'plugin-template')

  it.runIf(realSkeleton)('scaffolds cleanly with no example-plugin tokens left behind', () => {
    const dest = join(root, 'real')
    const result = scaffoldPlugin(realSkeleton!, dest, deriveNames('acme-crm'))

    expect(result.files.some((f) => f.startsWith('terraform/'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dest, 'biffo.plugin.json'), 'utf8')).name).toBe('acme-crm')

    // #1731 item 3, against the REAL skeleton's real uv.lock (not a fixture
    // stand-in) — the skeleton at this commit does carry one, so this is a
    // live check of the NEVER_COPY behaviour, not just the makeSkeleton()
    // fixture above.
    expect(
      existsSync(join(realSkeleton!, 'uv.lock')),
      'fixture drift: skeleton has no uv.lock to guard against',
    ).toBe(true)
    expect(existsSync(join(dest, 'uv.lock'))).toBe(false)
    expect(result.files).not.toContain('uv.lock')

    for (const rel of result.files) {
      expect(rel).not.toMatch(/example[-_]plugin/)
      if (/\.(py|toml|json|tf)$/.test(rel)) {
        expect(readFileSync(join(dest, rel), 'utf8')).not.toMatch(
          /example[-_]plugin|example_widgets|ExamplePlugin/,
        )
      }
    }
  })

  // Guards #647/#1492: the shared plugin host HARD-FAILS a deploy if a plugin
  // declares `admin_ingress` without a built `web-admin/dist`. A file-existence
  // check is not enough evidence that scaffolding satisfies that gate — three
  // real plugins each had a `web-admin/` that lint, typecheck and unit tests
  // all passed on, yet still shipped a broken `base` path invisible to every
  // one of those (biffo-template#1492). The only check that catches that class
  // is running the real build and reading what it emitted, so this does.
  //
  // Network + toolchain dependent (a real `pnpm install`), so it is slower and
  // more failure-prone than the rest of this file — skipped outright unless
  // the real skeleton is present, same guard as the test above, and given a
  // long timeout for a cold pnpm store.
  it.runIf(realSkeleton)(
    "a scaffolded plugin's web-admin actually builds, with assets under its own base path",
    () => {
      const dest = join(root, 'buildable')
      scaffoldPlugin(realSkeleton!, dest, deriveNames('acme-crm'))
      const webAdmin = join(dest, 'web-admin')
      expect(
        existsSync(join(webAdmin, 'package.json')),
        'no web-admin/package.json scaffolded',
      ).toBe(true)

      execSync('pnpm install --no-frozen-lockfile', { cwd: webAdmin, stdio: 'pipe' })
      execSync('pnpm run build', { cwd: webAdmin, stdio: 'pipe' })

      const indexHtml = readFileSync(join(webAdmin, 'dist', 'index.html'), 'utf8')
      const assetRefs = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((s) => s.includes('/assets/'))
      expect(assetRefs.length, 'no asset references in the built HTML').toBeGreaterThan(0)
      for (const ref of assetRefs) {
        expect(ref.startsWith('/api/v1/plugins/acme-crm/admin/'), `bad asset path: ${ref}`).toBe(
          true,
        )
      }
    },
    180_000,
  )
})
