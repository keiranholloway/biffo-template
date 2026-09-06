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
  // Mirrors the real skeleton's uv.lock shape (one [[package]] block naming
  // the example plugin itself — see the real uv.lock's `name =
  // "biffo-plugin-example"` entry) so a test can assert the substitution
  // table actually rewrites it, not just that the file is present.
  write(
    'skeleton/uv.lock',
    'version = 1\nrequires-python = ">=3.13"\n\n[[package]]\nname = "biffo-plugin-example"\nversion = "0.1.0"\nsource = { editable = "." }\n',
  )
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

  // Issue #1769: PR #1760 added `--locked` to every install-ing job in the
  // skeleton's own CI, which a `standalone` scaffold copies verbatim
  // (STANDALONE_ONLY_ENTRIES keeps `.github`). Before this fix `uv.lock` sat
  // in NEVER_COPY unconditionally, so a freshly scaffolded standalone plugin
  // had those workflows AND no lockfile for them to check — 5 of 6 CI jobs
  // red on commit #1, before a line of plugin logic existed. `uv.lock` is
  // not build/tool detritus for a standalone repo; it is the repo's own
  // load-bearing artefact, so it now lives in STANDALONE_ONLY_ENTRIES
  // (dropped for in-tree, kept — and substituted, like any other text file —
  // for standalone) rather than in NEVER_COPY (dropped unconditionally).
  it('keeps and substitutes uv.lock for the standalone layout (issue #1769)', () => {
    const dest = join(root, 'out')
    const result = scaffoldPlugin(makeSkeleton(), dest, deriveNames('acme-crm'), {
      layout: 'standalone',
    })

    expect(result.files).toContain('uv.lock')
    expect(existsSync(join(dest, 'uv.lock'))).toBe(true)
    const lockContents = readFileSync(join(dest, 'uv.lock'), 'utf8')
    expect(lockContents).toContain('biffo-plugin-acme-crm')
    expect(lockContents).not.toContain('biffo-plugin-example')
  })

  it('still drops uv.lock for the in-tree layout, with a reason (issue #1769)', () => {
    const dest = join(root, 'out')
    const result = scaffoldPlugin(makeSkeleton(), dest, deriveNames('acme-crm'))

    expect(existsSync(join(dest, 'uv.lock'))).toBe(false)
    expect(result.files).not.toContain('uv.lock')
    const skippedUvLock = result.skipped.find((s) => s.entry === 'uv.lock')
    expect(skippedUvLock).toBeDefined()
    expect(skippedUvLock?.reason).not.toHaveLength(0)
  })

  it('never copies build or VCS detritus', () => {
    const dest = join(root, 'out')
    scaffoldPlugin(makeSkeleton(), dest, deriveNames('acme-crm'))

    expect(existsSync(join(dest, 'node_modules'))).toBe(false)
    expect(existsSync(join(dest, '__pycache__'))).toBe(false)
  })

  // Regression guard for biffo-template#1731 item 3, UPDATED by #1769.
  // #1731 originally asked this to prove `uv.lock` is never copied at all —
  // true when it lived in NEVER_COPY unconditionally, but that turned out to
  // be the #1769 regression: the `standalone` layout needs its own
  // substituted copy (see the STANDALONE_ONLY_ENTRIES tests above), because
  // `applySubstitutions` already rewrites the one package-name token the
  // skeleton's lock carries. What must still hold, and what #1731 actually
  // cared about, is narrower: the DEFAULT (`in-tree`) layout — a plugin
  // merged into a monorepo's services/ — must never receive a nested
  // `uv.lock`, since the host resolves its own dependency tree and a copy
  // in there would be inert at best and confusing at worst.
  //
  // This is asserted against scaffoldPlugin's actual output (the file is
  // absent from both the returned file list AND the destination directory),
  // not by reading STANDALONE_ONLY_ENTRIES directly, so it fails if the set
  // is edited OR if the copy logic stops consulting it correctly.
  it('never copies uv.lock into the default in-tree layout (regression guard for #1731/#1769)', () => {
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

  // Unlike pnpm (guaranteed present — it is what invoked this very test run),
  // `uv` has no such guarantee: this suite runs under `pnpm test`, which
  // never implies a Python toolchain is on PATH. The one test below that
  // shells out to `uv sync` gates on this in addition to `realSkeleton`, so a
  // machine/job with the skeleton but no `uv` (or vice versa) skips with a
  // clear reason instead of crashing on "uv: not found". CI's "JS (lint,
  // types, test, audit)" job installs `uv` for exactly this reason (see
  // .github/workflows/ci.yml) — the gate is a safety net for local dev and
  // any future job shape, not a way to let the check go quietly unrun.
  let hasUv = false
  try {
    execSync('uv --version', { stdio: 'ignore' })
    hasUv = true
  } catch {
    hasUv = false
  }

  it.runIf(realSkeleton)('scaffolds cleanly with no example-plugin tokens left behind', () => {
    const dest = join(root, 'real')
    const result = scaffoldPlugin(realSkeleton!, dest, deriveNames('acme-crm'))

    expect(result.files.some((f) => f.startsWith('terraform/'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dest, 'biffo.plugin.json'), 'utf8')).name).toBe('acme-crm')

    // #1731 item 3 / #1769, against the REAL skeleton's real uv.lock (not a
    // fixture stand-in) — the skeleton at this commit does carry one, so
    // this is a live check that the default (in-tree) layout still drops
    // it, not just the makeSkeleton() fixture above.
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

  // Issue #1769: PR #1760 added `--locked` to every install-ing job in
  // _skeletons/plugin-template/.github/workflows/{ci,release}.yml, which the
  // `standalone` layout carries verbatim. `biffo plugin create --standalone`
  // never ran `uv lock`, and `uv.lock` sat in NEVER_COPY unconditionally, so
  // a freshly scaffolded standalone plugin's very first commit — the one
  // that triggers its very first CI run — had no lockfile at all: 5 of 6 CI
  // jobs would fail `uv sync --all-groups --locked` with "Unable to find
  // lockfile", before a single line of plugin logic was written.
  //
  // This runs the EXACT command every one of those jobs runs
  // (`uv sync --all-groups --locked`), against the EXACT directory
  // `scaffoldPlugin(..., { layout: 'standalone' })` produces from the REAL
  // skeleton — not a hand-written fixture — so it fails the same way CI
  // would if the uv.lock exclusion regresses back into NEVER_COPY, and
  // passes once the substituted skeleton lock is shipped instead.
  //
  // Network + toolchain dependent (a real `uv sync` resolve), so — like the
  // web-admin test above — it is skipped outright unless the real skeleton
  // is present, with a long timeout for a cold uv cache. Additionally gated
  // on `hasUv`: this file runs under `pnpm test`, which carries no guarantee
  // that a Python toolchain is on PATH (unlike pnpm itself, which invoked
  // this run). CI's JS job installs `uv` so this still executes on every PR.
  it.runIf(realSkeleton && hasUv)(
    "a standalone-scaffolded plugin satisfies 'uv sync --all-groups --locked' (issue #1769)",
    () => {
      const dest = join(root, 'standalone-locked')
      const result = scaffoldPlugin(realSkeleton!, dest, deriveNames('acme-crm'), {
        layout: 'standalone',
      })

      expect(result.files, 'uv.lock missing from scaffold output').toContain('uv.lock')
      expect(existsSync(join(dest, 'uv.lock')), 'uv.lock missing on disk').toBe(true)
      expect(readFileSync(join(dest, 'uv.lock'), 'utf8')).not.toMatch(/biffo-plugin-example/)

      execSync('uv sync --all-groups --locked', { cwd: dest, stdio: 'pipe' })
    },
    120_000,
  )
})
