import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BiffoConfig } from '../config/schema.js'
import type { GitHubAdapter } from '../adapters/source-control/github/index.js'
import { NON_INTERACTIVE_FLAG, NonInteractiveError } from '../lib/interactive.js'
import { log } from '../lib/logger.js'
import {
  chooseProject,
  describeProject,
  readRemoteCoreVersion,
  warnIfDispatchRefStale,
} from './deploy.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const promptMock = vi.fn()
vi.mock('inquirer', () => ({
  default: { prompt: (...args: unknown[]) => promptMock(...args) },
}))

function makeConfig(name: string, org: string, repo: string): BiffoConfig {
  return {
    project: { name, description: '' },
    dns: { mode: 'none' },
    source_control: { provider: 'github', config: { org, repo } },
    cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'us-east-1' } },
    environments: ['dev'],
    admin: { email: 'a@example.com', username: 'admin' },
  } as unknown as BiffoConfig
}

const PROJECTS = [
  makeConfig('biffo-platform', 'keiranholloway', 'biffo-platform'),
  makeConfig('tabsii-platform', 'tabsii-com', 'tabsii-platform'),
]

describe('describeProject', () => {
  it('renders name and org/repo', () => {
    expect(describeProject(PROJECTS[0]!)).toBe('biffo-platform (keiranholloway/biffo-platform)')
  })
})

describe('chooseProject', () => {
  const originalArgv = process.argv

  beforeEach(() => {
    promptMock.mockReset()
    process.argv = ['node', 'biffo', 'deploy', 'dev']
  })

  afterEach(() => {
    process.argv = originalArgv
    delete process.env['BIFFO_NON_INTERACTIVE']
  })

  it('prompts and returns the chosen project when interactive', async () => {
    promptMock.mockResolvedValue({ chosen: 'tabsii-platform' })

    // A real TTY is asserted explicitly — vitest's own process.stdin is never
    // a TTY, so the default parameter would trip the no-TTY guard below and
    // this test would stop testing the interactive branch at all.
    await expect(chooseProject(PROJECTS, true)).resolves.toBe(PROJECTS[1])
    expect(promptMock).toHaveBeenCalledOnce()
  })

  it('errors instead of prompting when non-interactive', async () => {
    process.argv = ['node', 'biffo', 'deploy', 'dev', '-y', NON_INTERACTIVE_FLAG]

    await expect(chooseProject(PROJECTS, true)).rejects.toThrow(NonInteractiveError)
    expect(promptMock).not.toHaveBeenCalled()
  })

  it('lists every candidate and names --project in the error', async () => {
    process.argv = ['node', 'biffo', 'deploy', 'dev', NON_INTERACTIVE_FLAG]

    // A script's operator has to be able to fix this from the error text alone.
    const error = await chooseProject(PROJECTS, true).catch((e: unknown) => e as Error)
    expect(error.message).toContain('--project <name>')
    for (const project of PROJECTS) {
      expect(error.message).toContain(describeProject(project))
    }
  })

  // Issue #1066 — the actual reported bug. `--non-interactive` was never
  // passed here; the flag alone was never the whole story. A script whose
  // stdin has no TTY attached (closed, /dev/null, piped) must be refused the
  // same way, because `promptOr`'s own guard cannot see stdin at all — it
  // only reads argv/env.
  it('errors instead of prompting when there is no interactive terminal, even without --non-interactive', async () => {
    process.argv = ['node', 'biffo', 'deploy', 'dev'] // deliberately no flag

    await expect(chooseProject(PROJECTS, false)).rejects.toThrow(NonInteractiveError)
    expect(promptMock).not.toHaveBeenCalled()
  })

  it('names --project and lists every candidate for the no-TTY case too', async () => {
    process.argv = ['node', 'biffo', 'deploy', 'dev']

    const error = await chooseProject(PROJECTS, false).catch((e: unknown) => e as Error)
    expect(error.message).toContain('--project <name>')
    for (const project of PROJECTS) {
      expect(error.message).toContain(describeProject(project))
    }
    // The reason given must be honest — the flag was never set here, so
    // claiming it was would send an operator chasing the wrong cause.
    expect(error.message).not.toContain(`${NON_INTERACTIVE_FLAG} is set`)
    expect(error.message).toContain('no interactive terminal is attached')
  })
})

/**
 * Build a fake GitHubAdapter whose getFileContent serves per-ref file contents.
 * `files[ref][path]` → string (present) or undefined (absent).
 */
function fakeGithub(files: Record<string, Record<string, string | undefined>>): GitHubAdapter {
  return {
    getFileContent: vi.fn(async (_org: string, _repo: string, path: string, ref?: string) => {
      return files[ref ?? 'main']?.[path]
    }),
  } as unknown as GitHubAdapter
}

const coreJson = (v: string) => JSON.stringify({ version: v })

describe('readRemoteCoreVersion', () => {
  it('prefers biffo.core.json over the inherited core.version', async () => {
    const gh = fakeGithub({
      dev: { 'biffo.core.json': coreJson('0.5.0'), 'core.version': '0.4.0\n' },
    })
    await expect(readRemoteCoreVersion(gh, 'o', 'r', 'dev')).resolves.toBe('0.5.0')
  })

  it('falls back to core.version when biffo.core.json is absent', async () => {
    const gh = fakeGithub({ dev: { 'core.version': '0.4.0\n' } })
    await expect(readRemoteCoreVersion(gh, 'o', 'r', 'dev')).resolves.toBe('0.4.0')
  })

  it('returns null when neither file is present', async () => {
    const gh = fakeGithub({ dev: {} })
    await expect(readRemoteCoreVersion(gh, 'o', 'r', 'dev')).resolves.toBeNull()
  })

  // #788 — this used to assert the opposite, and the opposite was the bug.
  //
  // `core.version` is a fossil: written once at `biffo init`, never maintained,
  // and no longer shipped by the template at all since #423. In `biffo-platform`
  // it reads 0.41.17 against a real 0.155.0 — 114 minor versions wrong. Falling
  // back to it when the authoritative record is *present but unreadable* turns a
  // defect that should be loud into a plausible wrong number, and the caller
  // then warns about a version mismatch that is an artefact of reading a fossil.
  it('returns null for a malformed biffo.core.json rather than trusting the fossil', async () => {
    const gh = fakeGithub({ dev: { 'biffo.core.json': '{ not json', 'core.version': '0.4.0\n' } })
    await expect(readRemoteCoreVersion(gh, 'o', 'r', 'dev')).resolves.toBeNull()
  })

  it('returns null when the record parses but carries no usable version', async () => {
    // Same reasoning: present-and-unusable is not the same as absent.
    for (const body of ['{}', '{"version": 5}', '{"version": "not-a-version"}']) {
      const gh = fakeGithub({ dev: { 'biffo.core.json': body, 'core.version': '0.4.0\n' } })
      await expect(readRemoteCoreVersion(gh, 'o', 'r', 'dev')).resolves.toBeNull()
    }
  })

  it('still falls back when the record is genuinely ABSENT, not merely unreadable', async () => {
    // The fallback exists for instances scaffolded before biffo.core.json; the
    // fix narrows it to that case rather than removing it.
    const gh = fakeGithub({ dev: { 'core.version': '0.4.0\n' } })
    await expect(readRemoteCoreVersion(gh, 'o', 'r', 'dev')).resolves.toBe('0.4.0')
  })

  it('does not warn about a mismatch it inferred from a fossil', async () => {
    // The consequence, end to end: dev's record is unreadable, so there is
    // nothing to compare and the deploy must stay silent — rather than
    // "main 0.4.0 is behind dev 0.9.0" read off a file nobody maintains.
    vi.mocked(log.warn).mockClear()
    const gh = fakeGithub({
      main: { 'biffo.core.json': coreJson('0.4.0') },
      dev: { 'biffo.core.json': '{ not json', 'core.version': '0.9.0\n' },
    })

    await warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'dev')

    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe('warnIfDispatchRefStale (issue #328)', () => {
  beforeEach(() => {
    vi.mocked(log.warn).mockClear()
  })

  it('warns loudly when the fixed dispatch ref is behind the branch being deployed', async () => {
    // A core upgrade landed on dev (0.5.0) but main (0.4.0) was never promoted.
    const gh = fakeGithub({
      main: { 'biffo.core.json': coreJson('0.4.0') },
      dev: { 'biffo.core.json': coreJson('0.5.0') },
    })

    await warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'dev')

    expect(log.warn).toHaveBeenCalled()
    const text = vi
      .mocked(log.warn)
      .mock.calls.map((c) => String(c[0]))
      .join('\n')
    expect(text).toContain('deploy-global.yml')
    expect(text).toContain("dispatched from 'main'")
    expect(text).toContain('0.4.0')
    expect(text).toContain('0.5.0')
    expect(text).toContain("Promote 'dev' → 'main'")
    expect(text).toContain('#328')
  })

  it('is silent when the dispatch ref is up to date with the deploy branch', async () => {
    const gh = fakeGithub({
      main: { 'biffo.core.json': coreJson('0.5.0') },
      dev: { 'biffo.core.json': coreJson('0.5.0') },
    })
    await warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'dev')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('is silent when the dispatch ref is AHEAD of the deploy branch', async () => {
    const gh = fakeGithub({
      main: { 'biffo.core.json': coreJson('0.6.0') },
      dev: { 'biffo.core.json': coreJson('0.5.0') },
    })
    await warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'dev')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('short-circuits (no API calls) when ref equals the deploy branch (prod)', async () => {
    const gh = fakeGithub({ main: { 'biffo.core.json': coreJson('0.5.0') } })
    await warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'main')
    expect(log.warn).not.toHaveBeenCalled()
    expect(gh.getFileContent).not.toHaveBeenCalled()
  })

  it('stays silent when a version cannot be read (never fabricates a mismatch)', async () => {
    const gh = fakeGithub({ main: {}, dev: { 'biffo.core.json': coreJson('0.5.0') } })
    await warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'dev')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('never throws when the API call fails — a diagnostic must not abort the deploy', async () => {
    const gh = {
      getFileContent: vi.fn(async () => {
        throw new Error('boom')
      }),
    } as unknown as GitHubAdapter
    await expect(
      warnIfDispatchRefStale(gh, 'o', 'r', 'deploy-global.yml', 'main', 'dev'),
    ).resolves.toBeUndefined()
    expect(log.warn).not.toHaveBeenCalled()
  })
})

/**
 * End-to-end reproduction of issue #1066, run as a real subprocess.
 *
 * Everything above exercises `chooseProject` in isolation, mocking inquirer
 * and reading `process.argv` directly — that proves the guard logic but
 * cannot prove the actual process exit code, because vitest's own process is
 * not the process under test. The reported bug was specifically that a
 * *real* `biffo deploy` process exits 0 despite failing: `inquirer`'s
 * `ExitPromptError`, once the picker's stdin hits EOF, is thrown from inside
 * Node's own process-exit sequence (`signal-exit`), a point after which no
 * further microtasks run — so no `.catch` anywhere, including the mocked one
 * a unit test would use, ever observes it. Only spawning the real CLI and
 * reading its real `$?` can catch a regression in that mechanism.
 *
 * Uses `tsx` against source directly (as `cli/package.json`'s own
 * `check:*` scripts already do) so this does not depend on a fresh `dist/`
 * build being present.
 */
describe('deploy — project-picker fallback under automation (issue #1066, real subprocess)', () => {
  const CLI_DIR = fileURLToPath(new URL('../../', import.meta.url))
  const TSX_BIN = join(CLI_DIR, 'node_modules', '.bin', 'tsx')
  const ENTRY = join(CLI_DIR, 'src', 'index.ts')

  let projectsDir: string
  let cwd: string

  function rawConfig(name: string, org: string, repo: string, accountId: string) {
    return {
      project: { name, description: '' },
      dns: { mode: 'none' },
      source_control: { provider: 'github', config: { org, repo } },
      cloud: { provider: 'aws', config: { account_id: accountId, region: 'us-east-1' } },
      environments: ['dev'],
      admin: { email: 'a@example.com', username: 'admin' },
    }
  }

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'biffo-1066-projects-'))
    // A biffo.config.json-free cwd — resolveConfig must fall through to
    // BIFFO_PROJECTS_DIR without ever finding a local config to short-circuit on.
    cwd = mkdtempSync(join(tmpdir(), 'biffo-1066-cwd-'))
    writeFileSync(
      join(projectsDir, 'biffo-platform.json'),
      JSON.stringify(
        rawConfig('biffo-platform', 'keiranholloway', 'biffo-platform', '123456789012'),
      ),
    )
    writeFileSync(
      join(projectsDir, 'tabsii-platform.json'),
      JSON.stringify(rawConfig('tabsii-platform', 'tabsii-com', 'tabsii-platform', '999999999999')),
    )
  })

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('exits non-zero, names --project, and never renders the picker, with closed stdin and no flag', () => {
    const result = spawnSync(TSX_BIN, [ENTRY, 'deploy', 'dev'], {
      cwd,
      env: { ...process.env, BIFFO_PROJECTS_DIR: projectsDir },
      input: '', // closed stdin — no TTY, exactly the automation scenario in #1066
      encoding: 'utf8',
      timeout: 30_000,
    })

    const output = `${result.stdout}\n${result.stderr}`

    // The core assertion the bug report was actually about: a caller checking
    // $? must see failure, not success.
    expect(result.status).not.toBe(0)
    expect(result.status).not.toBeNull()

    expect(output).toContain('--project <name>')
    expect(output).toContain('biffo-platform (keiranholloway/biffo-platform)')
    expect(output).toContain('tabsii-platform (tabsii-com/tabsii-platform)')

    // The interactive list-picker must never actually render — only its
    // navigation chrome could produce these markers.
    expect(output).not.toContain('navigate')
    expect(output).not.toContain('❯')
    // ...and the raw inquirer crash trace must be gone too.
    expect(output).not.toContain('ExitPromptError')
  }, 35_000)
})
