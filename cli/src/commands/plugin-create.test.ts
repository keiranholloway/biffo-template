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
import { runPluginCreate } from './plugin-create.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const SKELETON = findSkeletonRoot(new URL('.', import.meta.url).pathname, 'plugin-template')

function makeGitMock() {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    init: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    addRemote: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
  }
}

function makeGitHubMock() {
  return {
    createEmptyRepo: vi.fn().mockResolvedValue('https://github.com/acme/biffo-plugin-acme-crm.git'),
    setDefaultBranch: vi.fn().mockResolvedValue(undefined),
    protectSingleBranch: vi.fn().mockResolvedValue(undefined),
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
    })
  })
})
