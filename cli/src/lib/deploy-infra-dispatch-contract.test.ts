/**
 * A dispatch of `deploy-infra.yml` must either apply, or be refused. It must
 * never be quietly reinterpreted, in either direction.
 *
 * ## The two failures this sits between
 *
 * **#1582 — green, but nothing applied.** `deploy-infra.yml` accepted an
 * `action` input defaulting to `plan`. Left at that default it applied nothing,
 * and every job that would have applied was `skipped` rather than `failed`, so
 * the run's own `conclusion` stayed `success`. `conclusion` is the field every
 * external consumer reads, so a dry run and a real deploy were indistinguishable
 * to anything that did not open the job list. Real run `32553786917` shows it:
 * `conclusion: "success"` while its own `Deploy Outcome` job concluded
 * `failure`, masked by `continue-on-error: true`.
 *
 * **#1701 — meant to preview, actually applied.** Deleting the input fixed
 * #1582 and created its mirror image. The old dispatch shape
 * (`-f environment=dev`, relying on the removed `plan` default) was then
 * accepted with no error and run as an unconditional apply — real run
 * `32601969875`, `displayTitle: "Deploy Infrastructure — APPLY dev"`. That is a
 * one-way door against live infrastructure.
 *
 * ## What actually enforces the fix, and why it needs a test
 *
 * Three lines of YAML, enforced by GitHub's dispatch API before a run exists:
 *
 *   required: true      -> omitting it is `HTTP 422: Required input 'action'
 *                          not provided`
 *   (no `default:`)     -> nothing fills it in silently
 *   options: [apply]    -> `HTTP 422: Provided value 'plan' for input 'action'
 *                          not in the list of allowed values`
 *
 * Both 422s were measured against this repo's live API on 2026-08-22. The
 * enforcement is therefore real and outside our code — which is exactly why it
 * needs a test: nothing in CI executes a dispatch, so a `default: plan` added
 * back, or a second option, would restore #1582 silently and no suite would
 * notice. This test guards the declaration the API acts on.
 *
 * ## The case matrix, captured live
 *
 * Every line below is real output from a real `gh workflow run` against
 * `keiranholloway/biffo-template`, branch `fix/deploy-infra-split-plan-apply`,
 * on 2026-08-22. `BIFFO_DEPLOY_ENABLED` is unset in this repo (confirmed: the
 * variable API returns 404), so every job skips and nothing is ever applied —
 * that is what makes dispatching the applying workflow safe to test here.
 *
 * MUST NOT APPLY:
 *
 *   $ gh workflow run deploy-infra.yml --ref <branch> -f environment=dev
 *   HTTP 422: Required input 'action' not provided
 *
 *   $ gh workflow run deploy-infra.yml --ref <branch> -f environment=dev \
 *       -f action=plan
 *   HTTP 422: Provided value 'plan' for input 'action' not in the list of
 *   allowed values
 *
 * MUST APPLY (i.e. must be accepted and routed as an apply):
 *
 *   $ gh workflow run deploy-infra.yml --ref <branch> -f environment=dev \
 *       -f action=apply
 *   -> run 32602721640
 *   $ gh run view 32602721640 --json conclusion,displayTitle,event
 *   {"conclusion":"skipped",
 *    "displayTitle":"Deploy Infrastructure — APPLY dev",
 *    "event":"workflow_dispatch"}
 *
 * The first row is the decisive one: it is verbatim the command #1582's
 * reporter used, and before this change it produced run 32601969875 titled
 * "Deploy Infrastructure — APPLY dev" — accepted, and routed as an apply.
 *
 * NOT CAPTURED, and why: a live dispatch of `deploy-infra-plan.yml`. GitHub
 * refuses to dispatch a workflow that does not yet exist on the default branch
 * (`HTTP 404: workflow deploy-infra-plan.yml not found on the default branch`),
 * so the preview path can only be exercised after this merges. Its structure is
 * asserted statically below and by `workflow-apply-guard.test.ts`; its
 * execution is not.
 *
 * ## The one fix shape that must NOT be used
 *
 * Gating a job on `if: github.event.inputs.action == 'apply'` looks like the
 * obvious belt-and-braces and is the bug itself: a dispatch with the wrong
 * value would SKIP every job, and a run whose jobs all skipped concludes
 * `success`. Fail-closed here means "no run at all" or "a run that FAILED",
 * never "a green run that skipped" — so the absence of that `if:` is asserted
 * as deliberately as the input's presence.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = (f: string) => readFileSync(join(repoRoot, '.github/workflows', f), 'utf8')

/**
 * The lines of one `workflow_dispatch` input's block, comments stripped.
 *
 * Deliberately indentation-based rather than a YAML parse: the CLI has no YAML
 * dependency, and every other workflow guard in this directory reads the file
 * as text for the same reason. The block runs from `      <name>:` to the next
 * line indented six spaces or less.
 */
function inputBlock(yaml: string, name: string): string[] {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => l === `      ${name}:`)
  if (start === -1) return []
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (indent <= 6) break
    if (line.trimStart().startsWith('#')) continue
    body.push(line.trim())
  }
  return body
}

/**
 * The file with whole-line comments removed.
 *
 * These workflows carry long prose headers that quote the very strings this
 * test forbids (`PLAN ONLY`, `continue-on-error: true`, `terraform apply`), so
 * a naive substring check would read the explanation rather than the thing
 * being explained — the estate's #1362 class, a guard reading a different
 * document from the one that acts. Assertions about behaviour run against this.
 */
const code = (yaml: string) =>
  yaml
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')

/** Every `if:` condition in the file, as one line each. */
const ifConditions = (yaml: string) =>
  code(yaml)
    .split('\n')
    .filter((l) => /^\s*if:/.test(l))

describe('deploy-infra.yml dispatch contract (#1582, #1701)', () => {
  const infra = workflow('deploy-infra.yml')
  const action = inputBlock(infra, 'action')

  it('declares an `action` input at all, so the parser cannot pass on an empty read', () => {
    expect(
      action.length,
      'no `action:` input block found in deploy-infra.yml — either it was removed ' +
        '(#1701: the old dispatch shape then applies silently) or this test stopped ' +
        'finding it',
    ).toBeGreaterThan(0)
    // Sanity: the sibling input is still found the same way, so a rename of the
    // indentation convention fails loudly here rather than emptying the checks.
    expect(inputBlock(infra, 'environment').length).toBeGreaterThan(0)
  })

  it('requires `action`, so omitting it is a 422 and never a silent apply', () => {
    expect(
      action,
      'without `required: true` GitHub accepts a dispatch that omits `action` — ' +
        'which is #1701: `gh workflow run deploy-infra.yml -f environment=dev` ' +
        'applying real infrastructure',
    ).toContain('required: true')
  })

  it('gives `action` no default, so nothing fills the caller’s intent in for them', () => {
    expect(
      action.filter((l) => l.startsWith('default:')),
      'a `default:` on `action` re-creates #1582 if it is `plan` (green run, ' +
        'nothing applied) and #1701 if it is `apply` (preview shape applies). ' +
        'The safe state for an absent value is "refuse", which is what no ' +
        'default gets you.',
    ).toEqual([])
  })

  it('allows exactly one value, `apply`, so `action=plan` is a 422', () => {
    expect(action).toContain('type: choice')
    const options = action.find((l) => l.startsWith('options:'))
    expect(
      options,
      '`action` must be a `choice` with an explicit option list — a free-text ' +
        'string is accepted with any value and nothing rejects `plan`',
    ).toBe('options: [apply]')
  })

  it('gates no job on the value of `action` — that shape IS #1582', () => {
    const gated = ifConditions(infra).filter((l) => /inputs\.action/.test(l))
    expect(
      gated,
      'a job skipped because `action` was not `apply` produces a run whose ' +
        'conclusion is `success` having applied nothing — the original defect. ' +
        'The dispatch API rejects a bad value before a run exists; do not ' +
        'convert that hard failure into a skip.',
    ).toEqual([])
  })

  it('has no plan-only path left in the applying workflow', () => {
    expect(
      code(infra).includes('PLAN ONLY'),
      'the run-name plan-only marker (#1678) belongs to a state this workflow ' +
        'can no longer reach; if it is back, so is the ambiguity it marked',
    ).toBe(false)
    // The #1582 mitigation that could not work: a JOB that notices and
    // reports, marked `continue-on-error: true` so it cannot affect the
    // run's conclusion. A job-level `continue-on-error` sits at the same
    // 4-space indent as that job's own `runs-on:`/`steps:` keys, which is
    // what distinguishes it from a `continue-on-error: true` on an
    // individual STEP (biffo-template#1858: tolerating one optional
    // `download-artifact@v5` step that has no working ignore-if-missing
    // input of its own) -- a step failure there does not touch the job's
    // conclusion the way a masked job's did, so it is not the #1582 shape
    // and must not be flagged by this check.
    const masked = code(infra)
      .split('\n')
      .filter((l) => /^ {4}continue-on-error:\s*true\s*$/.test(l))
    expect(
      masked,
      'a `continue-on-error: true` job cannot change the run conclusion, which ' +
        'is why the original #1582 detector reported failure over a run that ' +
        'still read `success`',
    ).toEqual([])
  })
})

describe('deploy-infra-plan.yml is the preview path (#1582)', () => {
  const plan = workflow('deploy-infra-plan.yml')

  it('takes no `action` input — it has only one thing it can do', () => {
    expect(inputBlock(plan, 'action')).toEqual([])
    expect(inputBlock(plan, 'environment').length).toBeGreaterThan(0)
  })

  it('cannot apply, by construction rather than by condition', () => {
    // Not "is guarded from applying" — contains no apply at all, so there is no
    // guard to fail open.
    expect(code(plan)).not.toMatch(/terraform\s+apply/)
  })
})

describe('the CLI dispatches deploy-infra.yml on the contract it declares', () => {
  const deploy = readFileSync(join(repoRoot, 'cli/src/commands/deploy.ts'), 'utf8')

  it("sends action: 'apply', which is now required rather than optional", () => {
    // `biffo deploy` always means apply. Omitting the input would make the
    // dispatch a 422 at runtime, in an instance, at deploy time — a failure
    // this repo never executes and so can only catch here.
    const call = /triggerWorkflow\([^)]*'deploy-infra\.yml'[^)]*\)/s.exec(deploy)?.[0]
    expect(call, 'the deploy-infra.yml dispatch call was not found').toBeTruthy()
    expect(call).toContain("action: 'apply'")
    expect(call).toContain('environment')
  })
})
