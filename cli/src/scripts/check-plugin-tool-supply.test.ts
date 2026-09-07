/**
 * `biffo check plugin-tool-supply` (biffo-template#1409/#1413's wiring,
 * #1943's satellite fix).
 *
 * `runPluginToolSupplyCheck` takes no options — it always resolves its root
 * via `git rev-parse --show-toplevel` — so these tests mock the underlying
 * `execa` package (not `../lib/exec.js`, which just wraps it) to point that
 * resolution at a disposable tmp tree, the same technique
 * `check-plugin-allowlist-convention.test.ts` and
 * `check-eventbridge-log-permissions.test.ts` use for their own git call.
 * The underlying `auditPluginToolSupply`/`auditDeclaredModelIds` audit logic
 * is already exercised directly in `../lib/plugin-tool-supply-audit.test.ts`;
 * this file proves the CI entrypoint's own repo-type scoping, not the audit
 * itself.
 *
 * The satellite-shaped case (#1943) is the one this file exists to add: a
 * `services/_plugins`-less check already no-oped correctly
 * ("no services/_plugins/ — nothing to audit"), but the model-id half's only
 * scope check was `existsSync(servicesApiRoot)` — and every sibling app
 * `biffo sibling create` scaffolds carries its OWN `services/api/` (a thin
 * BFF, `_skeletons/sibling-template/services/api/`), a real directory with a
 * real `config.py` that happens to share the exact path this guard reads
 * for the ADR-0002 Core API. Running the model-id audit against it reported
 * "SETTINGS EXTRACTOR BLIND" and "MISSING
 * services/api/src/api/schemas/orchestration.py" on a perfectly healthy
 * sibling that never declared a model id in its life. A genuine finding in
 * the template or a real instance must still fail exactly as before; that is
 * exercised here too, so the fix cannot be read as silencing the real signal
 * along with the false one.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runPluginToolSupplyCheck } from './check-plugin-tool-supply.js'

vi.mock('execa', () => ({
  execa: vi.fn(),
}))

function write(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function setRoot(root: string): void {
  vi.mocked(execa).mockResolvedValue({ stdout: root } as never)
}

let exitCode: number | undefined

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error(`process.exit(${String(code)})`)
  }) as never)
})

describe('runPluginToolSupplyCheck', () => {
  it('skips cleanly (no crash) in a sibling tree whose services/api/ is its own unrelated BFF (#1943)', async () => {
    const root = makeTmpDir('plugin-tool-supply-satellite')
    // Shaped exactly like a real `biffo sibling create` scaffold: no
    // core-manifest.json, no biffo.core.json, but a real services/api/ with
    // a real config.py that is not the ADR-0002 Core API's Settings class.
    write(root, 'apps/frontend/package.json', '{"name": "satellite-app"}')
    write(
      root,
      'services/api/src/api/config.py',
      'class Settings(BaseSettings):\n    core_api_url: str = "https://example.invalid"\n',
    )
    setRoot(root)

    await expect(runPluginToolSupplyCheck()).resolves.toBeUndefined()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('skipped')
    expect(logged).not.toContain('SETTINGS EXTRACTOR BLIND')
    const errored = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(errored).toBe('')
  })

  it('is not fooled by a satellite that also happens to have an empty services/_plugins/-shaped dir', async () => {
    // Belt and braces: even if a sibling somehow carried a directory at that
    // exact path, repo-type scoping must still win over path presence.
    const root = makeTmpDir('plugin-tool-supply-satellite-with-plugins-dir')
    write(root, 'apps/frontend/package.json', '{"name": "satellite-app"}')
    mkdirSync(join(root, 'services', '_plugins'), { recursive: true })
    write(root, 'services/api/src/api/config.py', 'x: str = "y"\n')
    setRoot(root)

    await expect(runPluginToolSupplyCheck()).resolves.toBeUndefined()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('skipped')
  })

  it('still runs (does not skip) in an instance tree, and still no-ops cleanly with neither concept present', async () => {
    const root = makeTmpDir('plugin-tool-supply-instance-empty')
    // biffo.core.json is the instance marker (`isInstanceRepo`) — no
    // services/_plugins/ and no services/api/ at all, which is a legitimate
    // (if minimal) instance shape and must hit the PRE-EXISTING per-half
    // no-op messages, not the new satellite skip.
    write(root, 'biffo.core.json', JSON.stringify({ version: '1.0.0' }))
    setRoot(root)

    await expect(runPluginToolSupplyCheck()).resolves.toBeUndefined()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).not.toMatch(/skipped — this repo is not the template or an instance/)
    expect(logged).toContain('no services/_plugins/')
    expect(logged).toContain('no services/api/')
  })

  it('still fails closed in an instance tree whose services/api/ IS the real Core API but is missing the orchestration schema', async () => {
    const root = makeTmpDir('plugin-tool-supply-instance-real-api')
    write(root, 'biffo.core.json', JSON.stringify({ version: '1.0.0' }))
    write(
      root,
      'services/api/src/api/config.py',
      'agent_default_model: str = "moonshotai/kimi-k3"\n',
    )
    setRoot(root)

    await expect(runPluginToolSupplyCheck()).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('MISSING services/api/src/api/schemas/orchestration.py')
  })
})
