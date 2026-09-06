/**
 * `biffo check cognito-invite-template` (biffo-template#1363's wiring,
 * #1906's satellite fix).
 *
 * `runCognitoInviteTemplateCheck` takes no options — it always resolves its
 * root via `git rev-parse --show-toplevel` — so these tests mock the
 * underlying `execa` package (not `../lib/exec.js`, which just wraps it) to
 * point that resolution at a disposable tmp tree, the same technique
 * `check-branch-protection.test.ts` uses for its own git call.
 *
 * The satellite-shaped case (#1906) is the one this file exists to add: a
 * repo with no `modules/` directory at all used to be indistinguishable from
 * a repo whose module-Terraform discovery had broken, and
 * `runCognitoInviteTemplateCheck` hard-failed ("Refusing to report success
 * over zero input") on every satellite in the shared-sync rehearsal. The
 * genuine "discovery broke" case — `modules/` exists but has no .tf files at
 * all — must still fail exactly as before; that is exercised here too.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { runCognitoInviteTemplateCheck } from './check-cognito-invite-template.js'

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

describe('runCognitoInviteTemplateCheck', () => {
  it('is not applicable (exit 0, no crash) in a satellite tree with no modules/ at all (#1906)', async () => {
    const root = makeTmpDir('cognito-invite-satellite')
    write(root, 'apps/frontend/package.json', '{"name": "satellite-app"}')
    setRoot(root)

    await expect(runCognitoInviteTemplateCheck()).resolves.toBeUndefined()

    expect(process.exit).not.toHaveBeenCalled()
    const logged = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(logged).toContain('no modules/ directory')
    expect(logged.toLowerCase()).toContain('not applicable')
  })

  it('STILL fails (exit 1) when modules/ exists but has zero .tf files under it', async () => {
    const root = makeTmpDir('cognito-invite-broken-discovery')
    // modules/ exists but only carries a non-.tf file — genuine "discovery
    // broke" shape, must still fail closed exactly as before #1906's fix.
    write(root, 'modules/README.md', '# not terraform')
    setRoot(root)

    await expect(runCognitoInviteTemplateCheck()).rejects.toThrow('process.exit(1)')

    expect(exitCode).toBe(1)
    const reported = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(reported).toContain('Refusing to report success over zero input')
  })
})
