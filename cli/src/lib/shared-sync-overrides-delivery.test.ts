import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * `apply_overrides_floor`, the additive-only writer half of `#1352`.
 *
 * ## Why additive-only
 *
 * `overridesFloorNote` and `keyMustBeUniformNote` in `shared-files.json`
 * record why writing was deliberately left unbuilt: a one-way overwrite of a
 * diverged value destroys the evidence about which copy is right — the exact
 * injury `mustBeUniform` exists to prevent one level up, and #1352's own
 * `sharp` divergence (`^0.35.0` in three siblings, `>=0.35.0` in three others,
 * reconciled by hand across six PRs in #1380/#1381) is the worked example of
 * why that risk is real, not theoretical.
 *
 * That risk is scoped to a key ALREADY PRESENT with a value that might
 * disagree. It does not apply to a key that is simply absent — an absent key
 * carries no evidence to destroy, and `overridesFloor` already treats absence
 * as the unambiguous defect (#1352's own `nanoid`/`js-yaml` cost: a security
 * pin the template held and six repos silently lacked, blocking every open PR
 * in each for up to 38 minutes). So this function writes only the keys the
 * canonical copy declares that the target is MISSING, and never rewrites a
 * key the target already has — whatever its value. That is the whole safety
 * argument, and every test below is either proving that property or proving
 * the function refuses rather than guesses when it cannot be sure.
 *
 * ## Why a textual splice instead of `JSON.stringify`-and-rewrite
 *
 * `package.json`'s `name`/`version`/`dependencies`/`scripts` are legitimately
 * per-repo (that is the whole reason `pnpm.overrides` could not go in `files`
 * or `filesIfPresent` in the first place). Re-serialising the whole object
 * would reformat all of that too, and a security-pin PR that also produces an
 * unrelated multi-hundred-line reformatter diff is precondition (3) from
 * `keyMustBeUniformNote` — exactly what "confidence the JSON write does not
 * produce a reformatter diff" is about. So the function only ever INSERTS new
 * lines immediately after `"overrides": {`; every other byte of the file is
 * untouched, which the "byte-identical outside the insert" test below checks
 * directly rather than trusting the description.
 *
 * ## Why this extracts the function instead of running the script
 *
 * Same reasoning as `shared-sync-ship-guard.test.ts`: the function takes only
 * its two file-path arguments and has no dependency on worktrees, `git`, or
 * `gh`, so lifting it out of the script and calling it directly is the
 * smallest thing that exercises the real logic.
 */
const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'shared-sync.sh')

/** The `apply_overrides_floor()` definition, lifted out of the script. */
function fnSource(): string {
  const lines = readFileSync(script, 'utf8').split('\n')
  const start = lines.findIndex((l) => l === 'apply_overrides_floor() {')
  expect(start, 'apply_overrides_floor() not found — has it been renamed?').toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && l === '}')
  expect(end, 'no closing brace for apply_overrides_floor()').toBeGreaterThan(start)
  return lines.slice(start, end + 1).join('\n')
}

function run(target: string, canonical: string) {
  const program = `${fnSource()}\napply_overrides_floor ${JSON.stringify(target)} ${JSON.stringify(canonical)}\n`
  try {
    const stdout = execFileSync('bash', ['-c', program], { encoding: 'utf8' })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

const CANONICAL = JSON.stringify(
  {
    name: '@biffo/example',
    pnpm: {
      overrides: {
        'postcss@<8.5.18': '>=8.5.18',
        'sharp@<0.35.0': '>=0.35.0',
        'nanoid@<3.3.17': '>=3.3.17 <4',
      },
    },
  },
  null,
  2,
)

function writeFixture(dir: string, name: string, contents: string): string {
  const path = join(dir, name)
  writeFileSync(path, contents)
  return path
}

describe('apply_overrides_floor', () => {
  it('adds a missing key with the canonical value', () => {
    const dir = makeTmpDir('overrides-delivery')
    const target = writeFixture(
      dir,
      'target.json',
      `{
  "name": "tabsii-app",
  "pnpm": {
    "overrides": {
      "postcss@<8.5.18": ">=8.5.18",
      "sharp@<0.35.0": ">=0.35.0"
    }
  }
}
`,
    )
    const canonical = writeFixture(dir, 'canonical.json', CANONICAL)

    const { code, stdout } = run(target, canonical)

    expect(code).toBe(0)
    expect(stdout.trim()).toBe('nanoid@<3.3.17')
    const written = JSON.parse(readFileSync(target, 'utf8'))
    expect(written.pnpm.overrides['nanoid@<3.3.17']).toBe('>=3.3.17 <4')
  })

  it('adds every missing key when more than one is absent', () => {
    const dir = makeTmpDir('overrides-delivery')
    const target = writeFixture(
      dir,
      'target.json',
      `{
  "name": "tabsii-intake",
  "pnpm": {
    "overrides": {
      "postcss@<8.5.18": ">=8.5.18"
    }
  }
}
`,
    )
    const canonical = writeFixture(dir, 'canonical.json', CANONICAL)

    const { code, stdout } = run(target, canonical)

    expect(code).toBe(0)
    const applied = stdout.trim().split(' ').sort()
    expect(applied).toEqual(['nanoid@<3.3.17', 'sharp@<0.35.0'].sort())
    const written = JSON.parse(readFileSync(target, 'utf8'))
    expect(written.pnpm.overrides['nanoid@<3.3.17']).toBe('>=3.3.17 <4')
    expect(written.pnpm.overrides['sharp@<0.35.0']).toBe('>=0.35.0')
  })

  it('never rewrites a key that is already present, even if its value disagrees', () => {
    // This is the core safety property. tabsii-app/tabsii-marketplace's real
    // `sharp` divergence (`^0.35.0` vs canonical's `>=0.35.0`) is the worked
    // example in keyMustBeUniformNote of a value nobody had established was
    // safe to overwrite. This function must not be the thing that decides it.
    const dir = makeTmpDir('overrides-delivery')
    const target = writeFixture(
      dir,
      'target.json',
      `{
  "name": "tabsii-app",
  "pnpm": {
    "overrides": {
      "sharp@<0.35.0": "^0.35.0"
    }
  }
}
`,
    )
    const canonical = writeFixture(dir, 'canonical.json', CANONICAL)

    const { code, stdout } = run(target, canonical)

    expect(code).toBe(0)
    // sharp already present -> not touched. Only the truly missing keys ship.
    expect(stdout.trim().split(' ').sort()).toEqual(['nanoid@<3.3.17', 'postcss@<8.5.18'].sort())
    const written = JSON.parse(readFileSync(target, 'utf8'))
    expect(written.pnpm.overrides['sharp@<0.35.0']).toBe('^0.35.0')
  })

  it('touches no byte outside the inserted lines', () => {
    const dir = makeTmpDir('overrides-delivery')
    const original = `{
  "name": "tabsii-geo",
  "version": "0.4.1",
  "scripts": {
    "build": "next build"
  },
  "pnpm": {
    "overrides": {
      "postcss@<8.5.18": ">=8.5.18",
      "sharp@<0.35.0": ">=0.35.0"
    }
  },
  "dependencies": {
    "react": "19.0.0"
  }
}
`
    const target = writeFixture(dir, 'target.json', original)
    const canonical = writeFixture(dir, 'canonical.json', CANONICAL)

    const { code } = run(target, canonical)
    expect(code).toBe(0)

    const originalLines = original.split('\n')
    const writtenLines = readFileSync(target, 'utf8').split('\n')
    // Every original line is still present, unmodified, in order — the file
    // grew by exactly the inserted lines and nothing else moved or changed.
    let cursor = 0
    for (const line of originalLines) {
      const idx = writtenLines.indexOf(line, cursor)
      expect(
        idx,
        `line not found unmodified after cursor ${cursor}: ${JSON.stringify(line)}`,
      ).toBeGreaterThanOrEqual(cursor)
      cursor = idx + 1
    }
  })

  it('is a true no-op when the floor is already met', () => {
    const dir = makeTmpDir('overrides-delivery')
    const original = `{
  "name": "biffo-platform-app",
  "pnpm": {
    "overrides": {
      "postcss@<8.5.18": ">=8.5.18",
      "sharp@<0.35.0": ">=0.35.0",
      "nanoid@<3.3.17": ">=3.3.17 <4"
    }
  }
}
`
    const target = writeFixture(dir, 'target.json', original)
    const canonical = writeFixture(dir, 'canonical.json', CANONICAL)

    const { code, stdout } = run(target, canonical)

    expect(code).toBe(0)
    expect(stdout.trim()).toBe('')
    // Not one byte written, not merely "no keys reported".
    expect(readFileSync(target, 'utf8')).toBe(original)
  })

  it('refuses rather than guesses when the target has no "overrides": { line to anchor on', () => {
    const dir = makeTmpDir('overrides-delivery')
    const target = writeFixture(
      dir,
      'target.json',
      `{
  "name": "tabsii-map",
  "pnpm": {}
}
`,
    )
    const canonical = writeFixture(dir, 'canonical.json', CANONICAL)

    const { code, stdout } = run(target, canonical)

    expect(code).toBe(1)
    // Refused, not silently skipped: a caller relying on exit-code-0-means-fine
    // must not read this as "nothing to do".
    expect(readFileSync(target, 'utf8')).toContain('"pnpm": {}')
    expect(stdout.trim()).toBe('')
  })

  it('refuses on an unparsable target rather than writing garbage', () => {
    const dir = makeTmpDir('overrides-delivery')
    const target = writeFixture(dir, 'target.json', '{ not valid json')
    const canonical = writeFixture(dir, 'canonical.json', CANONICAL)

    const { code } = run(target, canonical)

    expect(code).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe('{ not valid json')
  })

  it('refuses on an unparsable canonical rather than writing garbage', () => {
    const dir = makeTmpDir('overrides-delivery')
    const target = writeFixture(
      dir,
      'target.json',
      `{
  "name": "tabsii-crm",
  "pnpm": {
    "overrides": {
      "postcss@<8.5.18": ">=8.5.18"
    }
  }
}
`,
    )
    const canonical = writeFixture(dir, 'canonical.json', '{ not valid json')

    const { code, stdout } = run(target, canonical)

    expect(code).toBe(1)
    expect(stdout.trim()).toBe('')
  })
})
