/**
 * The "Package and deploy the shared plugin host" step must fail closed when
 * a plugin declares `user_frontend` but ships no `web/` directory to build —
 * mirroring the `admin_ingress`/`web-admin` guard right above it in
 * `deploy-app.yml` (ADR-0021 §2, biffo-template#558 Milestone 2).
 *
 * Wired into ALL THREE deploy jobs, same reason `deploy-plugin-column-
 * check.test.ts` gives: `deploy-app.yml` duplicates its steps three times
 * (`deploy-dev`, `deploy-staging`, `deploy-prod`), so "wired in" is three
 * separate edits nothing else keeps in step, and biffo-template never runs
 * this workflow itself — a regression here is invisible until an instance's
 * deploy silently ships a plugin with a 404ing UI (biffo-plugin-idea-
 * scout#22 is exactly that failure, for the sibling admin_ingress check this
 * one mirrors).
 *
 * Structural (text-scan) assertions establish the check is present, wired
 * into every job, and shaped like its sibling. The execution test below goes
 * further and actually RUNS the extracted bash block against real fixture
 * directories, because a text match proves the string "exit 1" appears
 * somewhere — not that the script actually exits non-zero on the case it
 * claims to catch (the estate's own "read past the layer masking the truth"
 * rule).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(join(repoRoot, '.github/workflows/deploy-app.yml'), 'utf8')

const DEPLOY_JOBS = ['deploy-dev', 'deploy-staging', 'deploy-prod'] as const

/** Mirrors deploy-plugin-column-check.test.ts's own local helper (a text scan
 * rather than a YAML parse, to match every other workflow guard in this
 * directory). */
const jobBody = (yaml: string, job: string): string => {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => l === `  ${job}:`)
  expect(start, `deploy-app.yml declares a ${job} job`).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^ {2}[A-Za-z_][\w-]*:\s*$/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

const stepIndex = (body: string, name: string): number => body.indexOf(`      - name: ${name}`)

describe('deploy-app.yml fails closed when user_frontend has no web/', () => {
  it.each(DEPLOY_JOBS)('%s carries the user_frontend fail-closed check', (job) => {
    const body = jobBody(workflow, job)
    const step = body.slice(stepIndex(body, 'Package and deploy the shared plugin host'))
    expect(step).toContain(`jq -e '.user_frontend'`)
    expect(step).toContain('[ ! -d "$plugin_dir/web" ]')
    expect(step).toContain('::error')
    expect(step).toContain('exit 1')
    // Mirrors the web-admin block: build then copy dist/ into the host package.
    expect(step).toContain('cd "$plugin_dir/web"')
    expect(step).toContain('cp -r "$plugin_dir/web/dist" "$pkg/services/$name/web/dist"')
  })

  it.each(DEPLOY_JOBS)(
    '%s runs the user_frontend check inside the same step as web-admin',
    (job) => {
      // Position matters: both checks build off the SAME manifest/plugin_dir
      // loop iteration, so the user_frontend check must be the admin_ingress
      // check's sibling, not a step of its own reading stale loop state.
      const body = jobBody(workflow, job)
      const step = body.slice(stepIndex(body, 'Package and deploy the shared plugin host'))
      const adminCheck = step.indexOf(`jq -e '.admin_ingress'`)
      const frontendCheck = step.indexOf(`jq -e '.user_frontend'`)
      expect(adminCheck).toBeGreaterThan(-1)
      expect(frontendCheck).toBeGreaterThan(adminCheck)
      // Both checks close before the loop's own closing "done".
      const loopEnd = step.indexOf('\n          done\n')
      expect(loopEnd).toBeGreaterThan(frontendCheck)
    },
  )
})

/**
 * The extracted fail-closed block, executed for real against fixture
 * directories — not just matched as text. `pnpm` is stubbed (a no-op shell
 * function) because the point of this test is the fail-closed *branch*, not
 * a real frontend build; the "declares and ships web/" case pre-seeds
 * `web/dist` itself, the same way a real `pnpm run build` would have left it.
 */
function extractUserFrontendBlock(): string {
  const match = workflow.match(/if jq -e '\.user_frontend'[\s\S]*?\n {12}fi\n/)
  if (!match) {
    throw new Error('could not find the user_frontend fail-closed block in deploy-app.yml')
  }
  return match[0]
}

function runBlock(
  pluginDir: string,
  manifestPath: string,
  pkgDir: string,
): { status: number; output: string } {
  const block = extractUserFrontendBlock()
  const script = `
set -euo pipefail
manifest='${manifestPath}'
plugin_dir='${pluginDir}'
name='demo'
pkg='${pkgDir}'
mkdir -p "$pkg"
pnpm() { :; }  # stub: this test exercises the fail-closed branch, not a real build
${block}
echo "REACHED_END"
`
  try {
    const output = execFileSync('bash', ['-c', script], { encoding: 'utf8' })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string }
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('the extracted user_frontend block, actually executed', () => {
  it('MUST-CATCH: declares user_frontend, ships no web/ — exits non-zero', () => {
    const dir = makeTmpDir('deploy-user-frontend-missing')
    const pluginDir = join(dir, 'plugin')
    mkdirSync(pluginDir, { recursive: true })
    const manifestPath = join(dir, 'biffo.plugin.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({ user_frontend: { dir: 'web/dist', required_group: 'founder' } }),
    )
    // Deliberately no `web/` directory under pluginDir.

    const result = runBlock(pluginDir, manifestPath, join(dir, 'pkg'))

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('::error')
    expect(result.output).toContain('has no web/ directory')
    expect(result.output).not.toContain('REACHED_END')
  })

  it('MUST-NOT-CATCH: declares user_frontend AND ships web/dist — builds and copies, exits zero', () => {
    const dir = makeTmpDir('deploy-user-frontend-present')
    const pluginDir = join(dir, 'plugin')
    mkdirSync(join(pluginDir, 'web', 'dist'), { recursive: true })
    writeFileSync(join(pluginDir, 'web', 'dist', 'index.html'), '<div id="root"></div>')
    const manifestPath = join(dir, 'biffo.plugin.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({ user_frontend: { dir: 'web/dist', required_group: 'founder' } }),
    )

    const result = runBlock(pluginDir, manifestPath, join(dir, 'pkg'))

    expect(result.status).toBe(0)
    expect(result.output).toContain('REACHED_END')
    const copied = join(dir, 'pkg', 'services', 'demo', 'web', 'dist', 'index.html')
    expect(readFileSync(copied, 'utf8')).toContain('root')
  })

  it('MUST-NOT-CATCH: no user_frontend declared at all — no-ops, exits zero', () => {
    const dir = makeTmpDir('deploy-user-frontend-absent')
    const pluginDir = join(dir, 'plugin')
    mkdirSync(pluginDir, { recursive: true })
    const manifestPath = join(dir, 'biffo.plugin.json')
    writeFileSync(manifestPath, JSON.stringify({ user_ingress: { app: 'demo:app' } }))
    // No web/ directory either — irrelevant, since nothing was declared.

    const result = runBlock(pluginDir, manifestPath, join(dir, 'pkg'))

    expect(result.status).toBe(0)
    expect(result.output).toContain('REACHED_END')
    expect(result.output).not.toContain('::error')
  })
})
