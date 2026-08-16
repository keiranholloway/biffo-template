import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Detects the #1538/#1570 class: a template-owned file distributes into an
 * instance correctly, but the user-owned line that makes it DO anything is
 * never written, and nothing notices. The mechanism reads as shipped, is
 * green in CI, and is dead in the running system.
 *
 * ## The measured instance this was built for
 *
 * `infra/environments/dev/core-api-environment.core.tf` is template-owned and
 * rides every `biffo core upgrade`. It declares `local.core_api_environment`
 * (`BIFFO_PLUGIN_MEDIA_BUCKET`, `BIFFO_PR_SIGNER_FUNCTION_NAME`, ...). But
 * `module "core_api"` lives in user-owned `infra/environments/dev/main.tf`,
 * and Terraform cannot inject an argument into an existing module block from
 * a second file (`repo-layout-assertion-guard.test.ts`'s sibling investigation
 * on #1538 proved this empirically — `Duplicate module call`). So the channel
 * only takes effect if `main.tf` itself reads
 * `environment_variables = merge(local.core_api_environment, { ... })`. That
 * edit is a one-time, per-instance, manual step — #1579 shipped the channel,
 * `keiranholloway/biffo-platform` received the file on upgrade, and its
 * `main.tf` sat unread for three days until PR #174 fixed it by hand. Nothing
 * had ever noticed: `core-api-environment-adoption.test.ts` only guards the
 * TEMPLATE's own `main.tf`; there was no instance-side check at all.
 *
 * ## Why this is CLI logic, not a shipped `.test.ts`
 *
 * `cli/` is template-owned, so `biffo core upgrade` copies it — tests
 * included — into every instance (#367, #384). A `.test.ts` asserting fixed
 * content in `main.tf` would be exactly the class `python-test-scope-scan.ts`
 * exists to catch: `main.tf` is user-owned and legitimately different in
 * every instance, so a shipped assertion about its content either matches
 * nothing (vacuous) or reds an instance's CI on work nobody has done yet, with
 * no route to green except editing a file the test itself cannot see was
 * edited on the very branch that would fix it. `core-api-environment-
 * adoption.test.ts` sidesteps this by gating on `describe.skipIf(isInstanceRepo(...))`
 * and asserting only the TEMPLATE's own tree — silent everywhere else.
 *
 * The instance side has no equivalent gate available: it needs to assert
 * about a tree it does not control, on every instance, indefinitely. So it
 * does not live in a test at all. It lives here, as ordinary CLI code that
 * `cli/src/commands/core-upgrade.ts` calls against the REAL tree the command
 * is running against — `theirsDir` (the upgrade target) and `oursDir`
 * (`options.cwd`, the instance's own checkout) — and reports what it found.
 * Nothing about it ships as an assertion baked into an instance's own test
 * suite; it only ever runs when `biffo core upgrade` is actually invoked,
 * against whichever real tree that invocation is pointed at.
 *
 * `isAdopted` below is the one piece that IS unit-tested with literal fixture
 * strings (`instance-adoption.test.ts`) — including the real `main.tf` content
 * from `keiranholloway/biffo-platform` immediately before and after PR #174.
 * That is safe to ship: the function touches no filesystem path at all, so
 * `python-test-scope-scan.ts`'s scanner (and its TypeScript sibling,
 * `repo-layout-assertion-guard.test.ts`) have nothing to flag — there is no
 * `repoRoot`-derived read for either to catch.
 *
 * ## Registered pairs, not one hardcoded check
 *
 * `REGISTERED_ADOPTION_PAIRS` is a plain array so the next instance of this
 * class (#1540's non-env-var `module.core_api` arguments, or any future
 * "the file distributed, the adoption did not" channel) is one entry, not a
 * second copy of `checkInstanceAdoption`.
 *
 * ## What this does NOT verify (see `guard-authority-inventory.ts`'s
 * `instance-adoption` entry for the full accounting)
 *
 * `isAdopted` proves the LINE was written — that `main.tf`'s text matches the
 * shape Terraform needs. It does not run `terraform plan`/`apply`, so it
 * cannot see a syntactically-present `merge(local.core_api_environment, ...)`
 * later shadowed by a duplicate key, or a merge that is correct in source but
 * never actually applied. A per-instance `terraform apply` is out of reach for
 * a CLI check with no cloud credentials for the instance it is running
 * against; this is a source-level check, and the PR body it emits says so
 * rather than implying a verification it did not perform (AGENTS.md §4).
 *
 * ## The denominator
 *
 * `AdoptionReport.examinedInstances` is always stated by the caller, never
 * implied. `biffo core upgrade` runs against exactly one real instance tree
 * per invocation, so a genuine run always reports `1` — in contrast to
 * `cli/src/lib/cdn-error-status-coupling.test.ts` and
 * `cli/src/lib/workflow-global-output-wiring.test.ts` (#1529's guards),
 * which exist in no instance's tree and whose deploy workflow never runs in
 * the template either, so their real denominator is zero. A check that
 * reports "clean" without saying how many real instances it looked at is the
 * failure this module exists to avoid repeating.
 */

export interface AdoptionPair {
  /** Stable identifier, so a caller can filter or log without matching prose. */
  id: string
  /** What this pair is and why it exists — shown in output and remedies. */
  description: string
  /** Repo-relative (posix) path of the template-owned file whose presence in
   * the TARGET tree (`theirsDir`) makes this pair applicable. Absent there
   * (an upgrade to a version before the channel existed) means there is
   * nothing yet to adopt — not a finding. */
  templateFile: string
  /** Repo-relative (posix) path of the user-owned file the instance must edit
   * to consume the channel, read from the INSTANCE tree (`oursDir`). */
  userFile: string
  /** `userFile`'s content must match this to count as adopted. */
  adoptedPattern: RegExp
  /** What the instance operator must actually do, named concretely. */
  remedy: string
}

/**
 * Instance 1 of #1538/#1570, registered as data rather than a one-off
 * function — see the module docstring for the full evidence trail.
 */
export const REGISTERED_ADOPTION_PAIRS: AdoptionPair[] = [
  {
    id: 'core-api-environment',
    description:
      '`infra/environments/dev/core-api-environment.core.tf` declares ' +
      '`local.core_api_environment` (BIFFO_PLUGIN_MEDIA_BUCKET, ' +
      'BIFFO_PR_SIGNER_FUNCTION_NAME, ...), but `module "core_api"` is a user-owned ' +
      'block Terraform cannot inject an argument into from another file — so the ' +
      'channel only takes effect once `main.tf` itself merges it in (#1538/#1540/#1579).',
    templateFile: 'infra/environments/dev/core-api-environment.core.tf',
    userFile: 'infra/environments/dev/main.tf',
    adoptedPattern: /environment_variables\s*=\s*merge\(\s*local\.core_api_environment\s*,/,
    remedy:
      'In `module "core_api"` (infra/environments/dev/main.tf), change ' +
      '`environment_variables = {` to `environment_variables = merge(local.core_api_environment, {` ' +
      'and close the extra paren on the block’s closing `}` — then `terraform apply`.',
  },
]

export type AdoptionStatus = 'adopted' | 'unadopted' | 'not-applicable'

export interface AdoptionFinding {
  pair: AdoptionPair
  status: AdoptionStatus
}

/**
 * Pure: does `userFileContent` satisfy `pair`'s adoption pattern?
 *
 * No filesystem access — everything it needs is passed in — which is what
 * makes it safe to unit-test with literal strings and safe to ship inside
 * `cli/` to every instance (see module docstring). `null` (file absent)
 * always reads as not adopted: there is nothing to have merged the channel
 * into.
 */
export function isAdopted(pair: AdoptionPair, userFileContent: string | null): boolean {
  if (userFileContent === null) return false
  return pair.adoptedPattern.test(userFileContent)
}

export interface AdoptionReport {
  /** How many real instance trees this run examined. A genuine
   * `checkInstanceAdoption` call always reports exactly 1 — see the module
   * docstring's "the denominator" section for why that number is stated
   * rather than implied. */
  examinedInstances: number
  /** Total pairs in the registry, whether or not applicable to this upgrade. */
  registeredPairs: number
  /** Pairs whose `templateFile` exists in `theirsDir` — i.e. the channel this
   * upgrade's target actually ships. */
  applicablePairs: number
  findings: AdoptionFinding[]
}

/**
 * Check every registered pair against one real (theirsDir, oursDir) tree pair.
 *
 * A pair is `not-applicable` when the target tree does not yet ship the
 * channel — an instance upgrading to a version before it existed has nothing
 * to have adopted. Otherwise it is `unadopted` when the instance's `userFile`
 * is missing entirely, or present but not matching `adoptedPattern`,  and
 * `adopted` when it matches.
 */
export function checkInstanceAdoption(
  theirsDir: string,
  oursDir: string,
  pairs: AdoptionPair[] = REGISTERED_ADOPTION_PAIRS,
): AdoptionReport {
  const findings: AdoptionFinding[] = []
  let applicablePairs = 0

  for (const pair of pairs) {
    const shipped = existsSync(join(theirsDir, pair.templateFile))
    if (!shipped) {
      findings.push({ pair, status: 'not-applicable' })
      continue
    }
    applicablePairs++

    const userPath = join(oursDir, pair.userFile)
    const content = existsSync(userPath) ? readFileSync(userPath, 'utf8') : null
    findings.push({ pair, status: isAdopted(pair, content) ? 'adopted' : 'unadopted' })
  }

  return {
    examinedInstances: 1,
    registeredPairs: pairs.length,
    applicablePairs,
    findings,
  }
}
