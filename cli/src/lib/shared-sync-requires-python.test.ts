import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  makeTemplateCheckout,
  sharedSyncIn,
  writeSatelliteBridge,
} from '../test-utils/shared-sync-template.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `requiresPython` (shared-files.json, #1958): a Python-only guard script in
 * `files` must be skipped ENTIRELY -- both by drift-detection and by the
 * copy/stage path -- for a target repo with no Python anywhere in its tree,
 * while a repo that DOES have Python keeps receiving it exactly as before.
 *
 * `tabsii-offline` (a pure TypeScript/JS npm package, no `pyproject.toml`
 * anywhere) was receiving updated copies of `scripts/error_branch_coverage.py`
 * and the pip-audit scripts on every sync round with nothing in the repo ever
 * executing them -- confirmed live via `scripts/ci-wiring-audit.sh --estate`
 * reporting it UNWIRED. This predates any one PR: it is a property of the
 * manifest (every Python-only file was in the unconditional `files` list, with
 * no presence check), so it re-delivers dead content forever until the
 * manifest itself says these three files are conditional on Python.
 *
 * Drives the real `scripts/shared-sync.sh` (via `makeTemplateCheckout`)
 * against synthetic satellites -- never this repo's own estate, the isolation
 * `shared-sync-fixture-isolation.test.ts` enforces for every file in this
 * family.
 */

const GIT_ID = [
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'user.name=Fixture',
  '-c',
  'commit.gpgsign=false',
]

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-C', dir, ...GIT_ID, ...args], { stdio: 'pipe' })
}

const PY_FILE = 'scripts/error_branch_coverage.py'
const CANONICAL_CONTENT = '#!/usr/bin/env python3\nprint("canonical guard")\n'

/** A bare origin plus a clone on `dev`, carrying the sibling marker and
 * (optionally) a `pyproject.toml` somewhere in its tree -- never at a fixed
 * depth, mirroring a real sibling's `services/api/pyproject.toml` rather than
 * a root-only one (scripts/verify.sh's own `py_dirs()` exists because a
 * root-only check silently skipped every sibling, #855). */
function makeSatellite(estate: string, name: string, opts: { hasPython?: boolean } = {}): string {
  const origin = join(estate, `${name}.git`)
  mkdirSync(origin, { recursive: true })
  execFileSync('git', ['init', '--bare', '--initial-branch=dev', origin], { stdio: 'pipe' })

  const dir = join(estate, name)
  execFileSync('git', ['clone', origin, dir], { stdio: 'pipe' })
  writeFileSync(join(dir, 'biffo.sibling.json'), '{}\n')
  if (opts.hasPython) {
    mkdirSync(join(dir, 'services', 'api'), { recursive: true })
    writeFileSync(join(dir, 'services', 'api', 'pyproject.toml'), '[project]\nname = "fixture"\n')
  }
  writeSatelliteBridge(dir)
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'chore: fixture satellite')
  git(dir, 'push', 'origin', 'dev')
  return dir
}

/** A `gh` stub on `PATH` that answers just enough to let a real sync round
 * complete -- `repo view` for the default branch, `pr create` for phase 2. */
function makeFakeGh(binDir: string, logFile: string): void {
  mkdirSync(binDir, { recursive: true })
  const gh = join(binDir, 'gh')
  writeFileSync(
    gh,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}`,
      'if [ "${1:-}" = "repo" ] && [ "${2:-}" = "view" ]; then echo dev; exit 0; fi',
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "create" ]; then echo https://example.invalid/pr/1; exit 0; fi',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(gh, 0o755)
}

/** The content of `path` on the satellite's PUSHED `chore/sync-shared` branch
 * -- i.e. what actually reached the remote -- or `null` if the branch was
 * never pushed, or was pushed without that path. */
function pushedFile(satellite: string, path: string): string | null {
  const fetch = spawnSync('git', ['-C', satellite, 'fetch', '-q', 'origin', 'chore/sync-shared'], {
    encoding: 'utf8',
  })
  if (fetch.status !== 0) return null
  const res = spawnSync('git', ['-C', satellite, 'show', `FETCH_HEAD:${path}`], {
    encoding: 'utf8',
  })
  return res.status === 0 ? res.stdout : null
}

describe('shared-sync.sh requiresPython (#1958)', () => {
  it('--check does not report the Python-only file as drifted for a repo with no Python, but does for one that has it', () => {
    const root = makeTmpDir('requires-python-check')
    const estate = join(root, 'estate')
    mkdirSync(estate, { recursive: true })

    const template = makeTemplateCheckout(root, {
      manifest: {
        files: ['scripts/verify.sh', PY_FILE],
        requiresPython: [PY_FILE],
      },
      files: { [PY_FILE]: CANONICAL_CONTENT },
    })

    makeSatellite(estate, 'sat-no-python', { hasPython: false })
    makeSatellite(estate, 'sat-has-python', { hasPython: true })

    const res = spawnSync('sh', [sharedSyncIn(template), '--check', '--estate', estate], {
      encoding: 'utf8',
      cwd: template,
      timeout: 120_000,
    })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`

    // Both repos are DRIFTED on scripts/verify.sh (neither has it yet), so
    // both lines exist -- the assertion is about which FILE each line names.
    const noPythonLine = out.split('\n').find((l) => l.includes('sat-no-python'))
    const hasPythonLine = out.split('\n').find((l) => l.includes('sat-has-python'))
    expect(noPythonLine, out).toBeDefined()
    expect(hasPythonLine, out).toBeDefined()

    expect(noPythonLine).not.toContain(PY_FILE)
    expect(hasPythonLine).toContain(PY_FILE)
  }, 120_000)

  it('a real sync round skips the Python-only file for the Python-less repo, and ships it unchanged to the repo that has Python', () => {
    const root = makeTmpDir('requires-python-ship')
    const estate = join(root, 'estate')
    mkdirSync(estate, { recursive: true })

    const template = makeTemplateCheckout(root, {
      manifest: {
        files: ['scripts/verify.sh', PY_FILE],
        requiresPython: [PY_FILE],
      },
      files: { [PY_FILE]: CANONICAL_CONTENT },
    })

    const satNoPython = makeSatellite(estate, 'sat-no-python', { hasPython: false })
    const satHasPython = makeSatellite(estate, 'sat-has-python', { hasPython: true })

    const logFile = join(root, 'gh-calls.log')
    writeFileSync(logFile, '')
    const binDir = join(root, 'bin')
    makeFakeGh(binDir, logFile)

    const res = spawnSync('sh', [sharedSyncIn(template), '--estate', estate], {
      encoding: 'utf8',
      cwd: template,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      timeout: 120_000,
    })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`

    // Both repos still drift and ship on scripts/verify.sh alone, so this is
    // never a case of "nothing happened" -- confirms the round actually ran.
    expect(out, out).toMatch(/sat-no-python/)
    expect(out, out).toMatch(/sat-has-python/)

    expect(pushedFile(satNoPython, PY_FILE), out).toBeNull()
    expect(pushedFile(satHasPython, PY_FILE), out).toBe(CANONICAL_CONTENT)
    // And the unconditional file ships to both -- requiresPython narrows only
    // the one path named in the manifest, not the whole round.
    expect(pushedFile(satNoPython, 'scripts/verify.sh')).not.toBeNull()
    expect(pushedFile(satHasPython, 'scripts/verify.sh')).not.toBeNull()
  }, 120_000)
})
