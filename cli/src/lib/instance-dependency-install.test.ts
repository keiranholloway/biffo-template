import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunCommandFn } from './lockfile-refresh.js'
import {
  type DependencyInstallOutcome,
  dependencyInstallSteps,
  describeInstallFailures,
  installInstanceDependencies,
} from './instance-dependency-install.js'
import { makeTmpDir } from '../test-utils/tmp.js'

describe('dependencyInstallSteps', () => {
  let dir: string
  beforeEach(() => {
    dir = makeTmpDir('biffo-install')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('always includes pnpm install, regardless of what the upgrade touched', () => {
    const steps = dependencyInstallSteps(dir)
    expect(steps).toContainEqual({ ecosystem: 'pnpm', command: ['pnpm', 'install'] })
  })

  it('does not include uv sync when the instance has no pyproject.toml', () => {
    const steps = dependencyInstallSteps(dir)
    expect(steps.some((s) => s.ecosystem === 'uv')).toBe(false)
  })

  it('includes uv sync when the instance has a root pyproject.toml', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n')
    const steps = dependencyInstallSteps(dir)
    expect(steps).toContainEqual({ ecosystem: 'uv', command: ['uv', 'sync'] })
  })

  it('does not invent a Python step from a pyproject.toml nested in _skeletons/', () => {
    mkdirSync(join(dir, '_skeletons/sibling-template'), { recursive: true })
    writeFileSync(join(dir, '_skeletons/sibling-template/pyproject.toml'), '[project]\n')
    const steps = dependencyInstallSteps(dir)
    expect(steps.some((s) => s.ecosystem === 'uv')).toBe(false)
  })
})

describe('installInstanceDependencies', () => {
  let dir: string
  let run: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = makeTmpDir('biffo-install-run')
    run = vi.fn().mockResolvedValue({ ok: true })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs pnpm install even when the instance has no pyproject.toml', async () => {
    const outcomes = await installInstanceDependencies(dir, run as unknown as RunCommandFn)
    expect(run).toHaveBeenCalledWith(['pnpm', 'install'], dir)
    expect(run).not.toHaveBeenCalledWith(['uv', 'sync'], dir)
    expect(outcomes).toEqual([
      { step: { ecosystem: 'pnpm', command: ['pnpm', 'install'] }, ok: true },
    ])
  })

  it('also runs uv sync when the instance has a root pyproject.toml', async () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n')
    const outcomes = await installInstanceDependencies(dir, run as unknown as RunCommandFn)
    expect(run).toHaveBeenCalledWith(['pnpm', 'install'], dir)
    expect(run).toHaveBeenCalledWith(['uv', 'sync'], dir)
    expect(outcomes.map((o) => o.step.ecosystem)).toEqual(['pnpm', 'uv'])
  })

  it('continues past a failed step so one missing toolchain does not hide the other', async () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n')
    run.mockImplementation(async (command: readonly string[]) => {
      if (command[0] === 'pnpm') return { ok: false, error: 'pnpm: command not found' }
      return { ok: true }
    })

    const outcomes = await installInstanceDependencies(dir, run as unknown as RunCommandFn)

    expect(run).toHaveBeenCalledWith(['uv', 'sync'], dir)
    const pnpmOutcome = outcomes.find((o) => o.step.ecosystem === 'pnpm')
    const uvOutcome = outcomes.find((o) => o.step.ecosystem === 'uv')
    expect(pnpmOutcome).toEqual({
      step: { ecosystem: 'pnpm', command: ['pnpm', 'install'] },
      ok: false,
      error: 'pnpm: command not found',
    })
    expect(uvOutcome?.ok).toBe(true)
  })
})

describe('describeInstallFailures', () => {
  it('is empty when nothing failed', () => {
    const outcomes: DependencyInstallOutcome[] = [
      { step: { ecosystem: 'pnpm', command: ['pnpm', 'install'] }, ok: true },
    ]
    expect(describeInstallFailures(outcomes)).toEqual([])
  })

  it('names the ecosystem, the error, and the exact command to run by hand', () => {
    const outcomes: DependencyInstallOutcome[] = [
      {
        step: { ecosystem: 'pnpm', command: ['pnpm', 'install'] },
        ok: false,
        error: 'ENOENT: no such file or directory',
      },
    ]
    const [message] = describeInstallFailures(outcomes)
    expect(message).toContain('pnpm')
    expect(message).toContain('ENOENT: no such file or directory')
    expect(message).toContain('pnpm install')
  })
})
