import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INSTANCE_CORE_FILE } from '../lib/core-version.js'
import { findSkeletonRoot } from '../lib/plugin-scaffold.js'
import { log } from '../lib/logger.js'
import { runPluginCreate } from './plugin-create.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

/** Messages passed to log.warn so far, for assertions about advice given. */
function logWarnings(): string[] {
  return (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) =>
    String(c[0]),
  )
}

const SKELETON = findSkeletonRoot(new URL('.', import.meta.url).pathname, 'plugin-template')

function makeGitMock() {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    init: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    addRemote: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/acme/core-project.git'),
    cloneForEditing: vi.fn(),
    cleanup: vi.fn(),
  }
}

function makeGitHubMock() {
  return {
    createEmptyRepo: vi.fn().mockResolvedValue('https://github.com/acme/biffo-plugin-acme-crm.git'),
    setDefaultBranch: vi.fn().mockResolvedValue(undefined),
    protectSingleBranch: vi.fn().mockResolvedValue(undefined),
    setRepoVariable: vi.fn().mockResolvedValue(undefined),
    getRepoVariable: vi.fn().mockResolvedValue(undefined),
    repoRunnerCount: vi.fn().mockResolvedValue(3),
  }
}

/** Deps wired for the `--org` path, with no real GitHub anywhere. */
function remoteDeps(git = makeGitMock(), github = makeGitHubMock()) {
  return {
    deps: {
      git: git as never,
      makeGitHub: () => github as never,
      resolveToken: () => Promise.resolve('t0ken'),
    },
    git,
    github,
  }
}

let projectRoot: string

beforeEach(() => {
  // The mocked logger is module-level, so its calls accumulate across tests —
  // an assertion about "did this warn?" would otherwise see a previous test's.
  vi.mocked(log.warn).mockClear()
  projectRoot = mkdtempSync(join(tmpdir(), 'biffo-project-'))
  mkdirSync(join(projectRoot, 'services'), { recursive: true })
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

function options(overrides: Record<string, unknown> = {}) {
  return {
    firstParty: false,
    standalone: false,
    skeletonRoot: SKELETON!,
    dryRun: false,
    commit: true,
    cwd: projectRoot,
    ...overrides,
  }
}

describe.runIf(SKELETON)('runPluginCreate', () => {
  it('scaffolds a renamed plugin into the user-owned services/<name>/', async () => {
    const git = makeGitMock()

    await runPluginCreate('acme-crm', options(), { git: git as never })

    const dir = join(projectRoot, 'services', 'acme-crm')
    expect(JSON.parse(readFileSync(join(dir, 'biffo.plugin.json'), 'utf8')).name).toBe('acme-crm')
    expect(existsSync(join(dir, 'src', 'acme_crm'))).toBe(true)
  })

  // Issue #194 / PR #262 — the defect this must not reintroduce.
  it('carries terraform/ so the scaffolded plugin can actually receive events', async () => {
    await runPluginCreate('acme-crm', options(), { git: makeGitMock() as never })

    const dir = join(projectRoot, 'services', 'acme-crm')
    const manifest = JSON.parse(readFileSync(join(dir, 'biffo.plugin.json'), 'utf8'))
    expect(manifest.event_subscriptions.length).toBeGreaterThan(0)
    expect(existsSync(join(dir, 'terraform', 'main.tf'))).toBe(true)
  })

  it('scaffolds into the template-owned services/_plugins/ under --first-party', async () => {
    await runPluginCreate('acme-crm', options({ firstParty: true }), {
      git: makeGitMock() as never,
    })

    expect(existsSync(join(projectRoot, 'services', '_plugins', 'acme-crm'))).toBe(true)
    expect(existsSync(join(projectRoot, 'services', 'acme-crm'))).toBe(false)
  })

  it('refuses --first-party in an instance, where core upgrade would merge over it', async () => {
    writeFileSync(join(projectRoot, INSTANCE_CORE_FILE), JSON.stringify({ version: '0.26.0' }))

    await expect(
      runPluginCreate('acme-crm', options({ firstParty: true }), { git: makeGitMock() as never }),
    ).rejects.toThrow(/template-owned/)

    expect(existsSync(join(projectRoot, 'services', '_plugins'))).toBe(false)
  })

  it('stages and commits with a Conventional Commit message', async () => {
    const git = makeGitMock()

    await runPluginCreate('acme-crm', options(), { git: git as never })

    expect(git.add).toHaveBeenCalledWith(projectRoot, ['services/acme-crm'])
    expect(git.commit).toHaveBeenCalledWith(projectRoot, 'feat(plugins): scaffold acme-crm plugin')
  })

  it('leaves the scaffold uncommitted under --no-commit', async () => {
    const git = makeGitMock()

    await runPluginCreate('acme-crm', options({ commit: false }), { git: git as never })

    expect(existsSync(join(projectRoot, 'services', 'acme-crm'))).toBe(true)
    expect(git.commit).not.toHaveBeenCalled()
  })

  it('writes nothing under --dry-run', async () => {
    const git = makeGitMock()

    await runPluginCreate('acme-crm', options({ dryRun: true }), { git: git as never })

    expect(existsSync(join(projectRoot, 'services', 'acme-crm'))).toBe(false)
    expect(git.commit).not.toHaveBeenCalled()
  })

  it('rejects an invalid plugin name before touching the checkout', async () => {
    await expect(
      runPluginCreate('Acme_CRM', options(), { git: makeGitMock() as never }),
    ).rejects.toThrow('Invalid plugin name')
  })

  it('refuses to overwrite an existing plugin directory', async () => {
    mkdirSync(join(projectRoot, 'services', 'acme-crm'), { recursive: true })

    await expect(
      runPluginCreate('acme-crm', options(), { git: makeGitMock() as never }),
    ).rejects.toThrow('already exists')
  })

  it('refuses to run outside a Biffo project checkout', async () => {
    rmSync(join(projectRoot, 'services'), { recursive: true })

    await expect(
      runPluginCreate('acme-crm', options(), { git: makeGitMock() as never }),
    ).rejects.toThrow(/services does not exist/)
  })

  it('reports a missing skeleton rather than half-scaffolding', async () => {
    await expect(
      runPluginCreate('acme-crm', options({ skeletonRoot: join(projectRoot, 'nope') }), {
        git: makeGitMock() as never,
      }),
    ).rejects.toThrow(/Could not find the plugin skeleton/)
  })

  // #803 — the authoring shape ADR-0003 section 2 specifies, which until now no
  // command emitted, leaving the skeleton's own workflows delivered by nothing.
  describe('--standalone', () => {
    it('scaffolds a standalone repo directory rather than into services/', async () => {
      await runPluginCreate('acme-crm', options({ standalone: true }), {
        git: makeGitMock() as never,
      })

      const dir = join(projectRoot, 'biffo-plugin-acme-crm')
      expect(existsSync(dir)).toBe(true)
      expect(existsSync(join(projectRoot, 'services', 'acme-crm'))).toBe(false)
      expect(JSON.parse(readFileSync(join(dir, 'biffo.plugin.json'), 'utf8')).name).toBe('acme-crm')
    })

    it('keeps the CI/CD workflows the in-tree layout drops', async () => {
      // The entire point of #803: ADR-0003 section 2 says a plugin repo has an
      // independent CI/CD pipeline, and the in-tree scaffold correctly strips it.
      await runPluginCreate('acme-crm', options({ standalone: true }), {
        git: makeGitMock() as never,
      })

      const dir = join(projectRoot, 'biffo-plugin-acme-crm')
      expect(existsSync(join(dir, '.github', 'workflows', 'ci.yml'))).toBe(true)
      expect(existsSync(join(dir, '.github', 'workflows', 'release.yml'))).toBe(true)
      expect(existsSync(join(dir, '.github', 'workflows', 'publish-registry.yml'))).toBe(true)
      expect(existsSync(join(dir, 'registry-schema.json'))).toBe(true)
    })

    it('carries terraform/ too, same as the in-tree shape (#194)', async () => {
      await runPluginCreate('acme-crm', options({ standalone: true }), {
        git: makeGitMock() as never,
      })

      expect(existsSync(join(projectRoot, 'biffo-plugin-acme-crm', 'terraform', 'main.tf'))).toBe(
        true,
      )
    })

    it('initialises a NEW repo in the scaffold, not a commit into the current checkout', async () => {
      // The in-tree path commits into options.cwd. Doing that here would drop a
      // whole plugin repo into whatever checkout the user happened to run from.
      const git = makeGitMock()
      await runPluginCreate('acme-crm', options({ standalone: true }), { git: git as never })

      const dir = join(projectRoot, 'biffo-plugin-acme-crm')
      expect(git.init).toHaveBeenCalledWith(dir)
      expect(git.add).toHaveBeenCalledWith(dir, ['.'])
      expect(git.commit).toHaveBeenCalledWith(dir, expect.stringContaining('acme-crm'))
      expect(git.add).not.toHaveBeenCalledWith(projectRoot, expect.anything())
    })

    it('does not require a Biffo checkout — no services/ needed', async () => {
      // A standalone plugin repo is authored anywhere; demanding services/
      // would be the in-tree assumption leaking.
      rmSync(join(projectRoot, 'services'), { recursive: true, force: true })

      await runPluginCreate('acme-crm', options({ standalone: true }), {
        git: makeGitMock() as never,
      })

      expect(existsSync(join(projectRoot, 'biffo-plugin-acme-crm'))).toBe(true)
    })

    it('refuses to combine with --first-party', async () => {
      await expect(
        runPluginCreate('acme-crm', options({ standalone: true, firstParty: true }), {
          git: makeGitMock() as never,
        }),
      ).rejects.toThrow(/opposites/)
    })

    it('refuses to overwrite an existing directory', async () => {
      mkdirSync(join(projectRoot, 'biffo-plugin-acme-crm'), { recursive: true })

      await expect(
        runPluginCreate('acme-crm', options({ standalone: true }), {
          git: makeGitMock() as never,
        }),
      ).rejects.toThrow(/already exists/)
    })

    it('writes nothing on a dry run', async () => {
      const git = makeGitMock()
      await runPluginCreate('acme-crm', options({ standalone: true, dryRun: true }), {
        git: git as never,
      })

      expect(existsSync(join(projectRoot, 'biffo-plugin-acme-crm'))).toBe(false)
      expect(git.init).not.toHaveBeenCalled()
    })

    // #803 remote half — creating the repo, pushing, and protecting dev.
    describe('--org', () => {
      it('creates the repo, pushes dev, and sets it as the default branch', async () => {
        const { deps, git, github } = remoteDeps()

        await runPluginCreate('acme-crm', options({ standalone: true, org: 'acme' }), deps)

        expect(github.createEmptyRepo).toHaveBeenCalledWith(
          'acme',
          'biffo-plugin-acme-crm',
          expect.stringContaining('acme-crm'),
        )
        const dir = join(projectRoot, 'biffo-plugin-acme-crm')
        expect(git.addRemote).toHaveBeenCalledWith(
          dir,
          'origin',
          'https://github.com/acme/biffo-plugin-acme-crm.git',
        )
        expect(git.push).toHaveBeenCalledWith(dir, 'dev', { token: 't0ken' })
        expect(github.setDefaultBranch).toHaveBeenCalledWith('acme', 'biffo-plugin-acme-crm', 'dev')
      })

      it('protects dev ONLY, with the plugin CI\u2019s own job names', async () => {
        // The deployable path would protect dev/staging/main with the core
        // workflow's contexts — two branches a plugin repo never has, and
        // checks its CI never reports, which blocks every PR for ever.
        const { deps, github } = remoteDeps()

        await runPluginCreate('acme-crm', options({ standalone: true, org: 'acme' }), deps)

        expect(github.protectSingleBranch).toHaveBeenCalledTimes(1)
        const [, , branch, contexts] = github.protectSingleBranch.mock.calls[0] as [
          string,
          string,
          string,
          string[],
        ]
        expect(branch).toBe('dev')
        expect(contexts).toContain('Lint')
        expect(contexts).toContain('Validate biffo.plugin.json')
        // Not the core workflow's contexts.
        expect(contexts).not.toContain('JS (lint, types, test, audit)')
        expect(contexts).not.toContain('Terraform Validate & Security')
      })

      it('reads the contexts from the workflow it just wrote, not a hardcoded list', async () => {
        const { deps, github } = remoteDeps()

        await runPluginCreate('acme-crm', options({ standalone: true, org: 'acme' }), deps)

        const dir = join(projectRoot, 'biffo-plugin-acme-crm')
        const ci = readFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'utf8')
        const [, , , contexts] = github.protectSingleBranch.mock.calls[0] as [
          string,
          string,
          string,
          string[],
        ]
        for (const context of contexts) expect(ci).toContain(context)
      })

      it('creates and pushes the repo but skips protection when contexts cannot be determined', async () => {
        // A half-made repo is worse than an unprotected one: the push has
        // already happened by this point, so failing here would strand it.
        // Protection must be skipped rather than applied with an empty
        // contexts list, which would read as configured while gating nothing.
        const skeleton = join(projectRoot, 'skeleton-no-jobs')
        cpSync(SKELETON!, skeleton, { recursive: true })
        writeFileSync(join(skeleton, '.github/workflows/ci.yml'), 'name: CI\non: [push]\n')

        const { deps, git, github } = remoteDeps()
        await runPluginCreate(
          'acme-crm',
          options({ standalone: true, org: 'acme', skeletonRoot: skeleton }),
          deps,
        )

        expect(github.createEmptyRepo).toHaveBeenCalled()
        expect(git.push).toHaveBeenCalled()
        expect(github.setDefaultBranch).toHaveBeenCalled()
        expect(github.protectSingleBranch).not.toHaveBeenCalled()
      })

      it('refuses --org together with --no-commit, since there is nothing to push', async () => {
        const { deps } = remoteDeps()

        await expect(
          runPluginCreate(
            'acme-crm',
            options({ standalone: true, org: 'acme', commit: false }),
            deps,
          ),
        ).rejects.toThrow(/needs a commit to push/)
      })

      it('does not touch GitHub without --org', async () => {
        const { deps, github } = remoteDeps()

        await runPluginCreate('acme-crm', options({ standalone: true }), deps)

        expect(github.createEmptyRepo).not.toHaveBeenCalled()
        expect(github.protectSingleBranch).not.toHaveBeenCalled()
      })

      // Found by running --org against a real account: a brand-new repo has no
      // RUNNER_LABEL, so the skeleton CI falls back to ubuntu-latest, every job
      // fails at the billing wall before starting, and the protection this
      // command just applied then blocks every PR for ever on checks that can
      // never report.
      describe('RUNNER_LABEL', () => {
        it('mirrors the label from the checkout it runs in', async () => {
          const { deps, github } = remoteDeps()
          github.getRepoVariable.mockResolvedValue('biffo')

          await runPluginCreate('acme-crm', options({ standalone: true, org: 'acme' }), deps)

          expect(github.getRepoVariable).toHaveBeenCalledWith(
            'acme',
            'core-project',
            'RUNNER_LABEL',
          )
          expect(github.setRepoVariable).toHaveBeenCalledWith(
            'acme',
            'biffo-plugin-acme-crm',
            'RUNNER_LABEL',
            'biffo',
          )
        })

        it('prefers an explicit --runner-label over the mirrored one', async () => {
          const { deps, github } = remoteDeps()
          github.getRepoVariable.mockResolvedValue('biffo')

          await runPluginCreate(
            'acme-crm',
            options({ standalone: true, org: 'acme', runnerLabel: 'tabsii' }),
            deps,
          )

          expect(github.setRepoVariable).toHaveBeenCalledWith(
            'acme',
            'biffo-plugin-acme-crm',
            'RUNNER_LABEL',
            'tabsii',
          )
          // No point reading the source when the caller has already said.
          expect(github.getRepoVariable).not.toHaveBeenCalled()
        })

        it('warns rather than setting an empty label when there is nothing to mirror', async () => {
          const { deps, github } = remoteDeps()
          github.getRepoVariable.mockResolvedValue(undefined)

          await runPluginCreate('acme-crm', options({ standalone: true, org: 'acme' }), deps)

          expect(github.setRepoVariable).not.toHaveBeenCalled()
        })

        it('sets the label BEFORE the push that triggers the first CI run', async () => {
          // Observed live: `runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}`
          // resolves from whatever the variable is when the push dispatches the
          // run. Setting it afterwards is a race whose losing side sends the
          // first run to hosted runners — the billing failure this prevents.
          const order: string[] = []
          const git = makeGitMock()
          const github = makeGitHubMock()
          github.getRepoVariable.mockResolvedValue('biffo')
          github.setRepoVariable.mockImplementation(async () => {
            order.push('setRepoVariable')
          })
          git.push.mockImplementation(async () => {
            order.push('push')
          })

          await runPluginCreate('acme-crm', options({ standalone: true, org: 'acme' }), {
            git: git as never,
            makeGitHub: () => github as never,
            resolveToken: () => Promise.resolve('t0ken'),
          })

          expect(order).toEqual(['setRepoVariable', 'push'])
        })

        it('warns when the repo points at a fleet it cannot see', async () => {
          // biffo-runners#2, observed live: setting RUNNER_LABEL does not grant
          // the fleet's GitHub App access, so a new repo sees 0 runners and
          // every job queues for ever with no error — which under the
          // protection just applied blocks every PR, same as the billing wall.
          const { deps, github } = remoteDeps()
          github.getRepoVariable.mockResolvedValue('biffo')
          github.repoRunnerCount.mockResolvedValue(0)

          await runPluginCreate('acme-crm', options({ standalone: true, org: 'acme' }), deps)

          expect(github.repoRunnerCount).toHaveBeenCalledWith('acme', 'biffo-plugin-acme-crm')
          expect(logWarnings()).toEqual(
            expect.arrayContaining([expect.stringMatching(/can see 0 runners/)]),
          )
        })

        it('says nothing when runners are visible, or when the count is unknown', async () => {
          // null means "could not read", which is not the same claim as 0 and
          // must not produce a warning about a problem that may not exist.
          for (const count of [3, null]) {
            const { deps, github } = remoteDeps()
            github.getRepoVariable.mockResolvedValue('biffo')
            github.repoRunnerCount.mockResolvedValue(count)
            rmSync(join(projectRoot, 'biffo-plugin-acme-crm'), { recursive: true, force: true })
            vi.mocked(log.warn).mockClear()

            await runPluginCreate('acme-crm', options({ standalone: true, org: 'acme' }), deps)

            expect(logWarnings()).not.toEqual(
              expect.arrayContaining([expect.stringMatching(/can see 0 runners/)]),
            )
          }
        })

        it('still finishes when setting the label fails', async () => {
          // The repo is already created and pushed by this point; aborting
          // would strand it for a variable that can be set in one command.
          const { deps, github } = remoteDeps()
          github.getRepoVariable.mockResolvedValue('biffo')
          github.setRepoVariable.mockRejectedValue(new Error('403'))

          await expect(
            runPluginCreate('acme-crm', options({ standalone: true, org: 'acme' }), deps),
          ).resolves.toBeUndefined()
          expect(github.protectSingleBranch).toHaveBeenCalled()
        })
      })

      // Without this a new plugin is in neither registry path: no token for the
      // push path, and not listed in sources.json for the credential-free pull.
      // It would never appear in the store until somebody remembered — the
      // exact failure that left plugins.json empty for months.
      describe('registry sources.json', () => {
        function withRegistry(sources: unknown[] = []) {
          const registryDir = mkdtempSync(join(tmpdir(), 'biffo-registry-'))
          writeFileSync(
            join(registryDir, 'sources.json'),
            JSON.stringify({ note: 'n', sources }, null, 2),
          )
          const { deps, git, github } = remoteDeps()
          git.cloneForEditing.mockResolvedValue(registryDir)
          return { deps, git, github, registryDir }
        }

        it('adds the new plugin, then commits and pushes it', async () => {
          const { deps, git, registryDir } = withRegistry()

          await runPluginCreate('acme-crm', options({ standalone: true, org: 'acme' }), deps)

          const written = JSON.parse(readFileSync(join(registryDir, 'sources.json'), 'utf8')) as {
            sources: Array<{ name: string; manifest: string; repo: string }>
          }
          expect(written.sources.map((s) => s.name)).toEqual(['acme-crm'])
          expect(written.sources[0]?.manifest).toBe(
            'https://raw.githubusercontent.com/acme/biffo-plugin-acme-crm/dev/biffo.plugin.json',
          )
          // No .git suffix — the raw URL would 404 with it, and only a week
          // later when the scheduled sync next ran.
          expect(written.sources[0]?.repo).toBe('https://github.com/acme/biffo-plugin-acme-crm')

          expect(git.add).toHaveBeenCalledWith(registryDir, ['sources.json'])
          expect(git.push).toHaveBeenCalledWith(registryDir, 'main', { token: 't0ken' })
          expect(git.cleanup).toHaveBeenCalledWith(registryDir)
        })

        it('does not commit when the plugin is already listed', async () => {
          const { deps, git, registryDir } = withRegistry([
            { name: 'acme-crm', repo: 'x', manifest: 'y', tags: [] },
          ])

          await runPluginCreate('acme-crm', options({ standalone: true, org: 'acme' }), deps)

          expect(git.add).not.toHaveBeenCalledWith(registryDir, ['sources.json'])
          expect(git.cleanup).toHaveBeenCalledWith(registryDir)
        })

        it('warns but still finishes when the registry cannot be reached', async () => {
          // The plugin repo already exists, is pushed and is protected by now.
          // Failing here would strand all of that over one registry commit.
          const { deps, git } = remoteDeps()
          git.cloneForEditing.mockRejectedValue(new Error('network down'))

          await expect(
            runPluginCreate('acme-crm', options({ standalone: true, org: 'acme' }), deps),
          ).resolves.toBeUndefined()
          expect(logWarnings()).toEqual(
            expect.arrayContaining([expect.stringMatching(/will not appear in the portal/)]),
          )
        })

        it('skips registration under --no-register', async () => {
          const { deps, git } = withRegistry()
          await runPluginCreate(
            'acme-crm',
            options({ standalone: true, org: 'acme', register: false }),
            deps,
          )
          expect(git.cloneForEditing).not.toHaveBeenCalled()
        })
      })
    })
  })
})
