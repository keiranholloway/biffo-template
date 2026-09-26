/**
 * The dashboard plugin registry and the sibling's frontend-to-BFF path guard
 * must agree (biffo-template#2114).
 *
 * `frontendUrlForSlug` writes `/api/v1/plugins/<slug>/ui` into a sibling's
 * `apps/frontend/src/lib/plugins.ts`. The template-owned sibling guard
 * `_skeletons/sibling-template/services/api/tests/test_frontend_bff_paths.py`
 * fails every `/api/v1/...` literal under `apps/frontend/src` that this BFF does
 * not register. Each one was tested in isolation and each was green, so every
 * install of a `user_frontend` plugin reddened the app's own required CI (found
 * by the A5 run, #2012).
 *
 * This test runs the REAL guard, unmodified, over a `plugins.ts` written by the
 * REAL writer, in a checkout laid out the way a scaffolded sibling is — so the
 * URL shape the writer emits and the route family the guard exempts cannot
 * drift apart without this failing in the template's own CI, instead of in an
 * installer's first PR.
 *
 * It shells out to `uv` (resolving the skeleton's own `uv.lock`), and gates on
 * it being present exactly as `plugin-scaffold.test.ts` does: CI's JS job
 * installs `uv` for that reason; the gate is a safety net for a local machine
 * without one.
 */
import { execSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  PLUGIN_REGISTRY_RELATIVE_PATH,
  REGISTRY_END_MARKER,
  REGISTRY_START_MARKER,
  frontendUrlForSlug,
  titleFromSlug,
  upsertPluginRegistryEntry,
} from './plugin-frontend-registry.js'
import { PLUGIN_NAME_PATTERN } from './plugin-scaffold.js'
import { PluginManifestSchema } from './plugin-manifest.js'
import { makeTmpDir } from '../test-utils/tmp.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const skeleton = join(repoRoot, '_skeletons', 'sibling-template')
const GUARD_REL = join('services', 'api', 'tests', 'test_frontend_bff_paths.py')

let hasUv = false
try {
  execSync('uv --version', { stdio: 'ignore' })
  hasUv = true
} catch {
  hasUv = false
}

const PLUGINS_TS =
  'export type PluginManifest = { slug: string; title: string; frontendUrl: string }\n\n' +
  'export const INSTALLED_PLUGINS: PluginManifest[] = [\n' +
  `  ${REGISTRY_START_MARKER}\n` +
  `  ${REGISTRY_END_MARKER}\n` +
  ']\n'

describe.skipIf(!hasUv || !existsSync(skeleton))(
  'test_frontend_bff_paths.py over a plugins.ts the installer wrote (#2114)',
  () => {
    let checkout: string

    beforeAll(() => {
      checkout = makeTmpDir('biffo-bff-guard')
      const skip = (src: string): boolean =>
        !/(^|\/)(\.venv|node_modules|__pycache__|\.pytest_cache)(\/|$)/.test(src)
      cpSync(join(skeleton, 'services', 'api'), join(checkout, 'services', 'api'), {
        recursive: true,
        filter: skip,
      })
      cpSync(join(skeleton, 'apps', 'frontend', 'src'), join(checkout, 'apps', 'frontend', 'src'), {
        recursive: true,
        filter: skip,
      })
    }, 60_000)

    function writePlugins(extra = '', slugs: string[] = ['a5-throwaway']): string {
      const path = join(checkout, PLUGIN_REGISTRY_RELATIVE_PATH)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, PLUGINS_TS, 'utf8')
      for (const slug of slugs) {
        upsertPluginRegistryEntry(checkout, {
          slug,
          title: titleFromSlug(slug),
          frontendUrl: frontendUrlForSlug(slug),
        })
      }
      if (extra) writeFileSync(path, readFileSync(path, 'utf8') + extra, 'utf8')
      return path
    }

    function runGuard(): { status: number | null; output: string } {
      const r = spawnSync(
        'uv',
        [
          'run',
          '--locked',
          'pytest',
          '-q',
          '-p',
          'no:cacheprovider',
          GUARD_REL.replace('services/api/', ''),
        ],
        {
          cwd: join(checkout, 'services', 'api'),
          encoding: 'utf8',
          timeout: 240_000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        },
      )
      return { status: r.status, output: `${r.stdout}\n${r.stderr}` }
    }

    it('leaves the guard green after installing a user_frontend plugin', () => {
      writePlugins()
      const { status, output } = runGuard()
      expect(status, output).toBe(0)
    }, 300_000)

    // The guard once spelled the slug as `[a-z0-9]+(-[a-z0-9]+)*`, narrower than
    // the grammar the installer accepts, so `widgets-` and `a--b` reddened the
    // app's CI after a clean install. Every boundary of the installer's own
    // grammar goes through the real writer and the real guard in ONE run.
    it('stays green for the boundary slugs the installer grammar admits', () => {
      const slugs = ['a', 'x9', 'idea-scout', 'widgets-', 'a--b', 'a-1-b', 'z-']
      for (const slug of slugs) {
        expect(PLUGIN_NAME_PATTERN.test(slug), `scaffold grammar rejects ${slug}`).toBe(true)
        const parsed = PluginManifestSchema.safeParse({ name: slug, version: '1.0.0' })
        const nameIssues = parsed.success
          ? []
          : parsed.error.issues.filter((i) => i.path[0] === 'name')
        expect(nameIssues, `manifest grammar rejects ${slug}`).toEqual([])
      }
      writePlugins('', slugs)
      const { status, output } = runGuard()
      expect(status, output).toBe(0)
      for (const slug of slugs) expect(output).not.toContain(`'/api/v1/plugins/${slug}/ui'`)
    }, 300_000)

    it('is the exemption that turns it green: without it the same file fails (fail-first)', () => {
      writePlugins()
      const guard = join(checkout, GUARD_REL)
      const original = readFileSync(guard, 'utf8')
      const unfixed = original.replace(
        /^PLUGIN_HOST_UI_PATH = re\.compile\(.*\)$/m,
        'PLUGIN_HOST_UI_PATH = re.compile(r"(?!)")',
      )
      expect(unfixed, 'guard no longer defines PLUGIN_HOST_UI_PATH on one line').not.toBe(original)
      writeFileSync(guard, unfixed, 'utf8')
      try {
        const { status, output } = runGuard()
        expect(status).not.toBe(0)
        expect(output).toContain('UNMATCHED  apps/frontend/src/lib/plugins.ts')
        expect(output).toContain("'/api/v1/plugins/a5-throwaway/ui'")
      } finally {
        writeFileSync(guard, original, 'utf8')
      }
    }, 300_000)

    it('stays an allowlist: an unlisted /api/v1 path in the same file still fails', () => {
      writePlugins(
        "\nexport const STRAY = '/api/v1/courses'\nexport const NEAR = '/api/v1/plugins/a5-throwaway/ui/extra'\n",
      )
      const { status, output } = runGuard()
      expect(status).not.toBe(0)
      expect(output).toContain("'/api/v1/courses'")
      expect(output).toContain("'/api/v1/plugins/a5-throwaway/ui/extra'")
      expect(output).not.toMatch(/UNMATCHED[^\n]*'\/api\/v1\/plugins\/a5-throwaway\/ui'/)
    }, 300_000)
  },
)
