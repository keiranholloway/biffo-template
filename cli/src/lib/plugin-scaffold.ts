/**
 * Scaffolding a new plugin from `_skeletons/plugin-template/` (issue #200).
 *
 * The skeleton is written as a **standalone plugin repository** (ADR-0003
 * section 2): it carries its own CI workflows, its own release pipeline, and a
 * copy of the registry schema. Scaffolding it *in-tree* into a Biffo monorepo
 * means taking the plugin and leaving the repository — the monorepo already has
 * CI, already has a release process, and never publishes to the plugin registry
 * from inside itself. Carrying those files in would produce workflows that run
 * (and fail) in the host repo.
 *
 * What is deliberately **not** optional is `terraform/`: a plugin that declares
 * event subscriptions and ships no `terraform/` has no Lambda and no
 * EventBridge rule, so its subscriptions are inert in every deployment and
 * nothing reports it — issue #194, guarded in CI by `plugin-terraform-guard.ts`
 * and fixed in the skeleton by PR #262. The scaffolder carries it always, and
 * asserts it did.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Top-level skeleton entries that belong to a *standalone plugin repo* and have
 * no meaning in a monorepo. Each is dropped with a reason, not silently.
 */
export const STANDALONE_ONLY_ENTRIES: Record<string, string> = {
  '.github':
    'standalone-repo CI/release workflows — the host monorepo already runs lint/type/test/security over services/',
  'registry-schema.json':
    'the plugin-registry publishing schema, used when submitting a *published* plugin to the registry repo, not by an in-tree plugin',
}

/** Build/tool detritus that must never be copied out of a working skeleton. */
const NEVER_COPY = new Set([
  '.git',
  '.venv',
  'node_modules',
  '__pycache__',
  '.ruff_cache',
  '.pytest_cache',
  '.mypy_cache',
  'dist',
  'uv.lock',
  '.DS_Store',
])

export interface ScaffoldNames {
  /** Plugin slug, kebab-case: `acme-crm`. Matches `biffo.plugin.json`'s `name`. */
  slug: string
  /** Importable Python package name, snake_case: `acme_crm`. */
  pkg: string
  /** Python class prefix, PascalCase: `AcmeCrm` (used as `<Pascal>Plugin`). */
  pascal: string
  /** Python distribution name: `biffo-plugin-acme-crm`. */
  dist: string
}

export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Derive every naming variant from the plugin slug. The slug is the single
 * source of truth — it keys the manifest, the directory, the Terraform module
 * and the Lambda name, so everything else is computed from it rather than
 * asked for separately.
 */
export function deriveNames(slug: string): ScaffoldNames {
  if (!PLUGIN_NAME_PATTERN.test(slug)) {
    throw new Error(
      `Invalid plugin name '${slug}'. Expected a lowercase kebab-case slug ` +
        `starting with a letter, e.g. 'acme-crm' (this is what biffo.plugin.json's ` +
        `'name' field accepts, per registry-schema.json).`,
    )
  }
  const parts = slug.split('-')
  return {
    slug,
    pkg: parts.join('_'),
    pascal: parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(''),
    dist: `biffo-plugin-${slug}`,
  }
}

/**
 * Token substitutions applied to every copied text file's *contents* and to
 * file/directory *names*. Ordered longest-first so `biffo-plugin-example` is
 * rewritten before the bare `example-plugin` / `example` fragments inside it.
 */
function substitutions(names: ScaffoldNames): Array<[RegExp, string]> {
  return [
    [/biffo-plugin-example/g, names.dist],
    [/ExamplePlugin/g, `${names.pascal}Plugin`],
    // The example table. Table names are global in the instance's database, so
    // leaving every scaffolded plugin with `example_widgets` would have the
    // second one collide with the first at migration time.
    [/example_widgets/g, `${names.pkg}_widgets`],
    [/example_plugin/g, names.pkg],
    [/example-plugin/g, names.slug],
  ]
}

function applySubstitutions(text: string, names: ScaffoldNames): string {
  let out = text
  for (const [pattern, replacement] of substitutions(names)) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/** Extensions copied byte-for-byte rather than token-substituted. */
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|ico|woff2?|ttf|zip|gz)$/i

export interface ScaffoldResult {
  /** Repo-relative paths written, sorted. */
  files: string[]
  /** Top-level skeleton entries skipped, with the reason. */
  skipped: Array<{ entry: string; reason: string }>
}

/**
 * Copy `skeletonRoot` into `destDir`, renaming the example plugin to `names`
 * throughout (paths and contents) and dropping standalone-repo-only files.
 *
 * Throws rather than half-writing if the skeleton is missing `terraform/` —
 * see this module's header for why that directory is load-bearing.
 */
export function scaffoldPlugin(
  skeletonRoot: string,
  destDir: string,
  names: ScaffoldNames,
): ScaffoldResult {
  if (!existsSync(skeletonRoot)) {
    throw new Error(`Plugin skeleton not found at ${skeletonRoot}`)
  }
  if (!existsSync(join(skeletonRoot, 'terraform'))) {
    throw new Error(
      `Plugin skeleton at ${skeletonRoot} has no terraform/ directory. Refusing to ` +
        `scaffold a plugin that cannot receive events (issue #194) — the skeleton is broken.`,
    )
  }

  const skipped: Array<{ entry: string; reason: string }> = []
  const files: string[] = []

  const walk = (relDir: string): void => {
    const absDir = join(skeletonRoot, relDir)
    for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (NEVER_COPY.has(entry.name)) continue
      // Standalone-repo-only entries are only meaningful at the skeleton root.
      if (relDir === '' && entry.name in STANDALONE_ONLY_ENTRIES) {
        skipped.push({ entry: entry.name, reason: STANDALONE_ONLY_ENTRIES[entry.name]! })
        continue
      }

      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(relPath)
        continue
      }

      const destRel = applySubstitutions(relPath, names)
      const destPath = join(destDir, destRel)
      mkdirSync(dirname(destPath), { recursive: true })

      if (BINARY_EXTENSIONS.test(entry.name)) {
        copyFileSync(join(skeletonRoot, relPath), destPath)
      } else {
        writeFileSync(
          destPath,
          applySubstitutions(readFileSync(join(skeletonRoot, relPath), 'utf8'), names),
        )
      }
      files.push(destRel)
    }
  }

  walk('')

  if (!files.some((f) => f.startsWith('terraform/'))) {
    throw new Error(
      `Scaffold produced no terraform/ files from ${skeletonRoot} — refusing to leave a ` +
        `plugin whose event subscriptions could never fire (issue #194).`,
    )
  }

  return { files: files.sort(), skipped }
}

/**
 * Walk up from this module looking for `_skeletons/<name>`, mirroring
 * `sibling-create.ts`'s `defaultSiblingTemplateRoot()`. Works from both the
 * built `dist/` and `src/` in development.
 */
export function findSkeletonRoot(startDir: string, skeleton: string): string | null {
  let dir = startDir
  for (;;) {
    const candidate = join(dir, '_skeletons', skeleton)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
