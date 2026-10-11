import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import { assertTargetFidelity } from './core-upgrade-target-fidelity.js'
import { applyUpgradePlan, planCoreUpgrade } from './core-upgrade.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * A template-owned symlink (the real case: infra/environments/dev/tests/
 * knob_defaults/vars/core-api-variables.core.tf -> ../../../core-api-variables.core.tf)
 * must reach the instance as the same symlink, and the fidelity check must
 * flag an instance that lacks it.
 */
const LINK = 'infra/environments/dev/tests/knob_defaults/vars/core-api-variables.core.tf'
const TARGET = '../../../core-api-variables.core.tf'
const REAL = 'infra/environments/dev/core-api-variables.core.tf'

const manifest = {
  version: 1,
  templateOwned: ['infra/environments/dev/'],
  userOwned: [],
  seeded: [],
  released: [],
} as unknown as CoreManifest

describe('core upgrade delivers symlinks', () => {
  let base: string
  let theirs: string
  let ours: string

  const put = (root: string, rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  const link = (root: string, rel: string, target: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    symlinkSync(target, join(root, rel))
  }

  beforeEach(() => {
    base = makeTmpDir('biffo-sym-base')
    theirs = makeTmpDir('biffo-sym-theirs')
    ours = makeTmpDir('biffo-sym-ours')
    put(base, REAL, 'variable "a" {}\n')
    put(ours, REAL, 'variable "a" {}\n')
    put(theirs, REAL, 'variable "a" {}\n')
    link(theirs, LINK, TARGET)
    put(theirs, 'infra/environments/dev/tests/knob_defaults/vars/outputs.tf', 'output "x" {}\n')
    put(ours, 'infra/environments/dev/tests/knob_defaults/vars/outputs.tf', 'output "x" {}\n')
    put(base, 'infra/environments/dev/tests/knob_defaults/vars/outputs.tf', 'output "x" {}\n')
  })

  it('adds the symlink as a symlink with the same target', async () => {
    const plan = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest,
    })
    const e = plan.entries.find((x) => x.path === LINK)
    expect(e?.status).toBe('added')
    expect(e?.symlink).toBe(true)

    applyUpgradePlan(ours, plan, theirs)
    expect(lstatSync(join(ours, LINK)).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(ours, LINK))).toBe(TARGET)

    // Idempotent: a second plan sees nothing to do for the link.
    const again = await planCoreUpgrade({
      baseDir: theirs,
      oursDir: ours,
      theirsDir: theirs,
      manifest,
    })
    expect(again.entries.find((x) => x.path === LINK)?.status).toBe('unchanged')
  })

  it('replaces a regular file at the link path with the symlink', async () => {
    put(ours, LINK, TARGET)
    const plan = await planCoreUpgrade({
      baseDir: base,
      oursDir: ours,
      theirsDir: theirs,
      manifest,
    })
    expect(plan.entries.find((x) => x.path === LINK)?.status).toBe('add-conflict')
    applyUpgradePlan(ours, plan, theirs)
    expect(lstatSync(join(ours, LINK)).isSymbolicLink()).toBe(true)
  })

  describe('fidelity', () => {
    let repo: string
    beforeEach(() => {
      repo = makeTmpDir('biffo-sym-repo')
      const g = (args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
      g(['init', '-q'])
      g(['config', 'user.email', 't@example.com'])
      g(['config', 'user.name', 'T'])
      g(['config', 'commit.gpgsign', 'false'])
      put(repo, REAL, 'variable "a" {}\n')
      link(repo, LINK, TARGET)
      g(['add', '-A'])
      g(['commit', '-qm', 'core'])
      g(['tag', 'core-v1.0.0'])
    })

    it('passes when the plan delivers the symlink', async () => {
      const plan = await planCoreUpgrade({
        baseDir: base,
        oursDir: ours,
        theirsDir: theirs,
        manifest,
      })
      const report = assertTargetFidelity({
        entries: plan.entries,
        templateRepo: repo,
        toVersion: '1.0.0',
        theirsDir: theirs,
        manifest,
      })
      expect(report.findings).toEqual([])
    })

    it('flags an instance whose plan never delivers the symlink', () => {
      const report = assertTargetFidelity({
        entries: [],
        templateRepo: repo,
        toVersion: '1.0.0',
        theirsDir: theirs,
        manifest,
      })
      expect(report.findings).toEqual([{ path: LINK, reason: 'symlink-missing', source: 'output' }])
    })

    it('flags a symlink resolved as a regular file', () => {
      const report = assertTargetFidelity({
        entries: [{ path: LINK, status: 'added', conflicted: false, content: TARGET }],
        templateRepo: repo,
        toVersion: '1.0.0',
        theirsDir: theirs,
      })
      expect(report.findings).toEqual([
        { path: LINK, reason: 'symlink-not-delivered', source: 'output' },
      ])
    })
  })
})
