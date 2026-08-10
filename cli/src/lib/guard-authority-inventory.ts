/**
 * Guard/authority inventory for class issue #1362: "a guard resolves its
 * answer from a different document than the actor it is guarding."
 *
 * ## What this file is, and is not
 *
 * #1362's own history (10 instances, 3 disagreement tests, 0 sweep) already
 * answers the "can one universal test cover the class" question: **no.**
 * `wait-for-checks.ts` reads `statusCheckRollup` and disagrees with GitHub's
 * "latest run per check name"; `closing-keywords.ts` reads `PR_BODY` and
 * disagrees with the squash-merge commit; `main.py`'s router order and
 * `test_no_two_routes_claim_the_same_path_and_method` disagree about whether
 * a shadowed route is legal. Three different document shapes, three
 * different authorities, two different languages (TS, Python), one of them
 * not even a file GitHub or git exposes an API for (route registration
 * order). A single fixture-generator cannot construct all three divergent
 * states, because "divergent state" means something structurally different
 * in each.
 *
 * What CAN be swept, and is missing per the issue's 2026-08-09 comment
 * ("Nothing enumerates the guards ... guard nine will be written without one
 * exactly as guards one through eight were"), is the ENUMERATION: a list of
 * every guard that reads a "document" on behalf of an "actor", whether the
 * two are known to ever disagree, and whether a disagreement test exists.
 * `guard-authority-inventory.test.ts` asserts every TS guard discovered
 * under `cli/src/lib` is classified here — so a new in-class guard cannot be
 * merged silently uncounted, the same ratchet shape as
 * `guard-wiring-sweep.test.ts` (#1413) uses for callers instead of
 * disagreement tests.
 *
 * This is lever 2 from #1362 ("a disagreement test per guard ... this is the
 * sweep test: it enumerates the guards rather than testing one"), finished:
 * the per-guard tests already existed for 3/10 instances; this file and its
 * sweep are what makes "instance 11 gets no test" visible instead of silent.
 */

export interface GuardAuthorityRecord {
  /** Stable id — the guard's basename (no extension), or a short slug for a
   * guard that is not a `cli/src/lib/*.ts` file (a shell script, a Python
   * test, a workflow condition). */
  id: string
  /** Where the source of truth lives, for guards implemented in this
   * package. Absent for guards tracked here only for the inventory's sake
   * (out-of-language, e.g. Python or shell). */
  path?: string
  /** Is this guard an instance of the #1362 shape at all — does it resolve
   * an answer from ONE document on behalf of an actor that could, in
   * principle, read a DIFFERENT document about the same question? Most
   * guards in this repo assert a property of a single tree/file and have no
   * second document to disagree with — they are correctly `inClass: false`,
   * and forcing them into this class would be exactly the "3 guards swept
   * when there are 30" failure the dispatch brief warns about. */
  inClass: boolean
  /** The document the guard actually reads. */
  document?: string
  /** The actor whose real behaviour the guard is meant to certify. */
  actor?: string
  /** Path to a test that constructs the divergent state (document says X,
   * actor would do Y) and asserts the guard returns what the actor would
   * do — not merely that the guard runs without error. `null` when no such
   * test exists yet: the honest remainder this sweep exists to keep
   * visible. */
  disagreementTest: string | null
  /** One line: which issue/instance this is, or why it's out of scope. */
  note: string
}

export const GUARD_AUTHORITY_INVENTORY: GuardAuthorityRecord[] = [
  // ── In-class, WITH a disagreement test ──────────────────────────────────
  {
    id: 'wait-for-checks',
    path: 'scripts/wait-for-checks.sh',
    inClass: true,
    document: 'every entry in statusCheckRollup (GraphQL)',
    actor: "GitHub's merge gate, which honours only the latest run per check name",
    disagreementTest: 'cli/src/lib/wait-for-checks.test.ts',
    note: 'instance #1333, fixed #1368 — dedupe by check name keeping latest startedAt',
  },
  {
    id: 'closing-keywords',
    path: 'scripts/check-closing-keywords.mjs',
    inClass: true,
    document: 'PR_BODY only (pre-fix)',
    actor: 'GitHub, which builds the squash-merge commit from body + title + every commit message',
    disagreementTest: 'cli/src/lib/closing-keywords.test.ts',
    note: 'instance #1334, fixed #1370 — documentsFor() now reads body, title and every commit',
  },

  // ── In-class, no TS disagreement test (out-of-language: Python) ─────────
  {
    id: 'route-shadow-ordering',
    inClass: true,
    document: "test_no_two_routes_claim_the_same_path_and_method's route walk",
    actor:
      "main.py's include order, which deliberately lets a product domain shadow core's /whoami",
    disagreementTest: 'services/api/tests/test_main_router_ordering.py',
    note:
      "instance #10, fixed #1472 — Python, not TS, so this sweep cannot verify the test file's " +
      'content mechanically; recorded so the guard is not silently absent from the estate-wide count',
  },

  // ── In-class, STILL NO disagreement test — the honest remainder ─────────
  {
    id: 'core-ownership-guard',
    path: 'cli/src/lib/core-ownership-guard.ts',
    inClass: true,
    document: "core-manifest.json's templateOwned prefix list",
    actor:
      "core-upgrade.ts's classify(), which returns keep-ours/orphaned for any path with no base and no theirs",
    disagreementTest: null,
    note:
      'instance #8, reported 2026-08-08/09, STILL OPEN per the issue thread ("second occurrence — ' +
      'same day, different file"). A prefix match claims services/api/ template-owned; classify() ' +
      'cannot carry a path the template has never shipped. Needs a disagreement test that builds a ' +
      'manifest prefix with no matching template file and asserts the guard and classify() agree ' +
      "it is instance-owned (or asserts the guard fails loudly, naming the guard's own gap — either " +
      'is a fix; today neither exists, so the guard commit-blocks with an impossible instruction).',
  },
  {
    id: 'claim-structural-resolver',
    inClass: true,
    document: "claim.sh's closingIssuesReferences + branch-name check",
    actor: "GitHub's actual claim state under this estate's own Refs-not-Closes convention",
    disagreementTest: null,
    note:
      'instance #9 (#1411): a PR body saying "Refs #N" (which the DDL policy REQUIRES) populates ' +
      'neither signal claim.sh reads, so the guard reports the issue free while a PR for it is ' +
      'open. Four prior fixes (#1281, #1311, #1327, and this one) patched the same resolver; the ' +
      "issue's own 2026-08-09 comment names this as the strongest case for a structural resolver " +
      'plus its own disagreement test, neither built yet.',
  },
  {
    id: 'core-direct-paths-audit',
    path: 'cli/src/lib/core-direct-paths-audit.ts',
    inClass: true,
    document: "biffo-template's own route registrations",
    actor:
      'the sibling instance actually serving the request (template routes + its own domains/<name>/ routes)',
    disagreementTest: 'cli/src/lib/core-direct-paths-audit.test.ts',
    note:
      'instance #9 (numbered #1428 in its own issue), reported 2026-08-10: all 9 findings on its ' +
      'first real run were false positives, because the template registers zero of the /public/ ' +
      'routes a sibling frontend calls — those are served by the INSTANCE, which the audit never ' +
      "reads. Fixed by resolveSiblingCoreSrc() (already shipped, reading biffo.sibling.json's " +
      'core_project). Disagreement test added: a synthetic estate with a template core registering ' +
      'nothing under /public/ and a resolved instance core that does — the audit disagrees (fails) ' +
      "against the template and agrees (passes) against resolveSiblingCoreSrc()'s resolved instance.",
  },

  // ── NOT in class: single-document guards (why they are excluded) ────────
  {
    id: 'adr-numbering-guard',
    path: 'cli/src/lib/adr-numbering-guard.ts',
    inClass: false,
    disagreementTest: null,
    note: 'reads docs/ADR/ once, asserts internal uniqueness — no second document/actor to disagree with',
  },
  {
    id: 'branch-protection-audit',
    path: 'cli/src/lib/branch-protection-audit.ts',
    inClass: false,
    disagreementTest: null,
    note: 'reads live GitHub branch-protection API directly — the document IS the actor here, not a copy of it',
  },
  {
    id: 'cognito-invite-template-guard',
    path: 'cli/src/lib/cognito-invite-template-guard.ts',
    inClass: false,
    disagreementTest: null,
    note: 'content check within one Terraform block — no competing authority',
  },
  {
    id: 'eventbridge-log-permission-guard',
    path: 'cli/src/lib/eventbridge-log-permission-guard.ts',
    inClass: false,
    disagreementTest: null,
    note: 'cross-references two Terraform resources in the SAME tree, not two different documents about the deployed actor',
  },
  {
    id: 'lambda-output-guard',
    path: 'cli/src/lib/lambda-output-guard.ts',
    inClass: false,
    disagreementTest: null,
    note: 'greps a fixed CLI output string — no second source of truth',
  },
  {
    id: 'pipe-trap-guard',
    path: 'cli/src/lib/pipe-trap-guard.ts',
    inClass: false,
    disagreementTest: null,
    note: 'shell-script AST-adjacent pattern check on shell scripts themselves — one document',
  },
  {
    id: 'plugin-collision-guard',
    path: 'cli/src/lib/plugin-collision-guard.ts',
    inClass: false,
    disagreementTest: null,
    note: 'compares plugin manifests to each other, all read the same way — no actor/document split',
  },
  {
    id: 'plugin-terraform-guard',
    path: 'cli/src/lib/plugin-terraform-guard.ts',
    inClass: false,
    disagreementTest: null,
    note: 'checks a plugin manifest against its own directory listing — one filesystem, one read',
  },
  {
    id: 'plugin-tool-supply-audit',
    path: 'cli/src/lib/plugin-tool-supply-audit.ts',
    inClass: false,
    disagreementTest: null,
    note: "checks a plugin manifest against the plugin repo's own declared tool sources — one repo, one read",
  },
  {
    id: 'release-subject-guard',
    path: 'cli/src/lib/release-subject-guard.ts',
    inClass: false,
    disagreementTest: null,
    note: "validates a commit subject against commitlint.config.js's own type list — one document",
  },
  {
    id: 'skeleton-drift-guard',
    path: 'cli/src/lib/skeleton-drift-guard.ts',
    inClass: false,
    disagreementTest: null,
    note: 'compares a skeleton to itself over time / to a declared property list — no external actor to diverge from',
  },
  {
    id: 'terraform-input-guard',
    path: 'cli/src/lib/terraform-input-guard.ts',
    inClass: false,
    disagreementTest: null,
    note: 'static scan of Terraform variable resolution in CI — the guard and the actor (terraform apply) read the same files',
  },
]
