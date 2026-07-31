/**
 * A workflow step that runs Python must invoke an interpreter the runner
 * actually has, at the version the artefact is built for.
 *
 * `deploy-app.yml` shipped a bare `python -m compileall` in three jobs. None of
 * those jobs runs `actions/setup-python`; they install uv with
 * `python-version: '3.13'`, which puts **no `python` on PATH**. The
 * self-hosted runners carry `python3` only, so the step died with
 * `python: command not found`, exit 127 — after a successful build, and after
 * the core version had already been resolved and baked in. That ordering is
 * why it read as a second versioning bug (#414) rather than a missing
 * interpreter.
 *
 * It survived because GitHub-hosted images ship `python-is-python3`. The bug
 * arrived when the estate moved onto its own runners, and **this repo never
 * runs `deploy-app.yml`** — biffo-template is non-deployable, it publishes to
 * npm — so the workflow is authored here and exercised only in whichever
 * instance takes it next. Same argument as `workflow-relative-paths.test.ts`:
 * the guard has to live in the repo that owns the file.
 *
 * Two things are asserted, and the second is the one that will matter later:
 *
 * 1. no bare `python` invocation, because the runner has none;
 * 2. the pinned interpreter matches that job's own `setup-uv` `python-version`.
 *
 * (2) exists because `--invalidation-mode unchecked-hash` bytecode is only
 * loadable by the minor version that produced it. Build it with the wrong one
 * and Lambda silently ignores every `.pyc` — a green deploy that quietly loses
 * the optimisation the line exists for, with nothing anywhere to see. Bumping
 * `setup-uv` and forgetting this line is the obvious way to cause that, so the
 * two are tied together here rather than left to memory.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// cli/src/lib/ -> cli/src/ -> cli/ -> repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = join(repoRoot, '.github/workflows/deploy-app.yml')
const lines = readFileSync(workflow, 'utf8').split('\n')

/** Strip the leading `#` comment body so prose about `python` never trips this. */
const code = lines.map((line) => (/^\s*#/.test(line) ? '' : line))

describe('deploy-app.yml python interpreter', () => {
  it('never invokes a bare `python`, which no runner in this estate provides', () => {
    const offenders = code
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /(^|[\s(=$'"`])python\s+-m\s/.test(line))
      .filter(({ line }) => !/python3\s+-m\s/.test(line))
      // `uv run … python -m …` is the fixed form: the interpreter is uv's.
      .filter(({ line }) => !/\buv\s+run\b[^\n]*\bpython\s+-m\s/.test(line))
    expect(offenders.map((o) => `line ${o.n}: ${o.line.trim()}`)).toEqual([])
  })

  it('pins the same interpreter its job installed with setup-uv', () => {
    // Every `python-version:` in this file belongs to a setup-uv step. Pair each
    // compileall call with the nearest one ABOVE it — the job it runs in.
    const declared = code
      .map((line, i) => ({ v: /python-version:\s*'?([\d.]+)'?/.exec(line)?.[1], n: i }))
      .filter((d): d is { v: string; n: number } => Boolean(d.v))
    expect(declared.length).toBeGreaterThan(0)

    const calls = code
      .map((line, i) => ({ line, n: i }))
      .filter(({ line }) => line.includes('compileall'))
    expect(calls.length).toBeGreaterThan(0)

    const mismatched = calls.map(({ line, n }) => {
      const job = declared.filter((d) => d.n < n).pop()
      const pinned = /--python\s+([\d.]+)/.exec(line)?.[1]
      return { n: n + 1, pinned, job: job?.v }
    })
    for (const m of mismatched) {
      expect(m.pinned, `line ${m.n} must pin an interpreter version`).toBeDefined()
      expect(m.pinned, `line ${m.n} pins ${m.pinned}, its job installs ${m.job}`).toBe(m.job)
    }
  })
})
