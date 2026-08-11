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
 *
 * ## Instance 11 sharpened what "classified" has to mean
 *
 * Instance 11 (`core-upgrade-target-fidelity.ts`, the #1399 fidelity guard)
 * was not the usual shape: the guard did not read a DIFFERENT document from
 * the actor and disagree with it — it re-read the SAME document (a target
 * tag's file) through the SAME lossy `readFileSync(..., 'utf8')` decode the
 * actor already used, and a `git show` fallback that decoded it the same
 * lossy way again. Two independently-mangled strings agreeing is not
 * verification, and `disagreementTest` alone cannot express that: a
 * disagreement test proves a guard catches two documents that differ, but
 * says nothing about HOW the guard derives its answer, so a guard that
 * shares its actor's decoder can pass every disagreement test built against
 * it and still be blind to exactly this. Every `inClass: true` record below
 * therefore also carries `independence`, answering a narrower question than
 * `disagreementTest` does: does the guard's OWN derivation route share a
 * helper, parser or decode step with the actor's, such that a corruption in
 * that shared step would be invisible to both sides at once?
 *
 * `core-upgrade-target-fidelity` is itself added below despite never being
 * discovered by this sweep's own enumeration (`discoverGuardFiles`'s
 * `/-(audit|guard)\.ts$/` pattern does not match `-fidelity.ts`) — the same
 * shape as `route-shadow-ordering`, added by hand for the same reason. This
 * is worth stating plainly: the enumeration test that exists to make sure no
 * guard goes unclassified missed the guard that turned out to be this
 * class's sharpest instance, because its OWN document (a naming-convention
 * regex) disagreed with the actual authority (which files are guards, as
 * their own docstrings declare — this file's docstring names #1362 by
 * number). `guard-wiring-sweep.test.ts`'s own comment already names this as
 * a known, tracked gap ("`*-check.ts` and `*-fidelity.ts` guards are not
 * discovered by the current glob") — recorded here rather than silently
 * re-discovered, and left unfixed in that shared file: widening the
 * discovery regex changes what #1413's wiring sweep also requires (every
 * newly-discovered guard must be wired or explicitly baselined), which is a
 * decision belonging to that sweep's own owner, not a side effect of this
 * one adding a hand-classified entry.
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
  /**
   * Instance 11's sharper property (#1362): does the guard's own derivation
   * — the helper, parser or decode step it uses to produce ITS answer —
   * share a mechanism with the actor's, such that a corruption in that
   * shared step would mangle both reads identically and the guard would
   * report agreement over a real divergence? `disagreementTest` proves a
   * guard catches two documents that differ; it says nothing about HOW the
   * guard's own read is derived, which is exactly the gap instance 11 found
   * (`{ checked: 1, findings: [] }` over a file that had just been written
   * corrupt, because both sides of the comparison were decoded the same
   * lossy way). Required whenever `inClass` is true — absent (`undefined`)
   * reads as unswept, not as "independent by default".
   *
   *   - `'independent'`   — the guard's derivation route shares no helper,
   *     parser or decode step with the actor's; a shared-step corruption
   *     cannot make both sides agree wrongly.
   *   - `'shared-path'`   — it does, and the exposure is real: a guard in
   *     this state can return a clean report over a file it just watched go
   *     wrong, the way `core-upgrade-target-fidelity` did before its fix.
   *   - `'unclear'`       — not yet run to ground; recorded rather than
   *     guessed, per this sweep's own "an honest `unclear` beats a
   *     manufactured verdict" standard.
   */
  independence?: 'independent' | 'shared-path' | 'unclear'
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
    independence: 'independent',
    note:
      'instance #1333, fixed #1368 — dedupe by check name keeping latest startedAt. Swept for ' +
      'instance-11 exposure 2026-08-11: the guard reads statusCheckRollup ONCE via gh api and ' +
      "applies its OWN group_by/max_by dedup logic to GitHub's documented rule; there is no " +
      'second re-read of the same field through an identical decode to fall back on, so a ' +
      'corruption in the fetch cannot make two reads of it agree wrongly. Independent by ' +
      'construction, not merely by absence of a bug found yet.',
  },
  {
    id: 'closing-keywords',
    path: 'scripts/check-closing-keywords.mjs',
    inClass: true,
    document: 'PR_BODY only (pre-fix)',
    actor: 'GitHub, which builds the squash-merge commit from body + title + every commit message',
    disagreementTest: 'cli/src/lib/closing-keywords.test.ts',
    independence: 'independent',
    note:
      'instance #1334, fixed #1370 — documentsFor() now reads body, title and every commit. ' +
      'Swept for instance-11 exposure 2026-08-11: resolveBody()/resolveTitle()/resolveCommits() ' +
      'each fetch their field once via `gh api` (or a documented stale-payload fallback, see ' +
      "resolveBody's own comment) and hand it to documentsFor() as plain text — no second read " +
      'of the same field through a matching decode step exists to agree with the first one wrongly.',
  },

  // ── In-class, no TS disagreement test (out-of-language: Python) ─────────
  {
    id: 'route-shadow-ordering',
    inClass: true,
    document: "test_no_two_routes_claim_the_same_path_and_method's route walk",
    actor:
      "main.py's include order, which deliberately lets a product domain shadow core's /whoami",
    disagreementTest: 'services/api/tests/test_main_router_ordering.py',
    independence: 'independent',
    note:
      "instance #10, fixed #1472 — Python, not TS, so this sweep cannot verify the test file's " +
      'content mechanically; recorded so the guard is not silently absent from the estate-wide count. ' +
      'Swept for instance-11 exposure 2026-08-11: the test imports `api.main` and reads ' +
      "`api_main.app` directly — FastAPI's own live route table, built by the same import the " +
      'real server runs, not a re-implementation of route registration. This is the strongest ' +
      "form of independence available (asserting against the authority's own live object, per " +
      "this class's own remedy list), so a corruption in some re-derivation step is not even " +
      'possible — there is no second derivation, only the one real structure.',
  },

  // ── In-class, added by hand — NOT discovered by this sweep's own glob ───
  {
    id: 'core-upgrade-target-fidelity',
    path: 'cli/src/lib/core-upgrade-target-fidelity.ts',
    inClass: true,
    document:
      "the target tag's own git blob, read via `git ls-tree`/`git show` at the moment of the check",
    actor:
      "core-upgrade.ts's planner, which writes theirsDir's resolved content to the instance verbatim",
    disagreementTest: 'cli/src/lib/core-upgrade-target-fidelity.test.ts',
    independence: 'independent',
    note:
      'INSTANCE 11 — the guard this whole "independence" field exists for. Not discovered by ' +
      "discoverGuardFiles()'s `/-(audit|guard)\\.ts$/` pattern (the file is named `*-fidelity.ts`), " +
      'so it sat outside this inventory entirely until now — see the module docstring above. ' +
      'Found while fixing #1506: the VERBATIM_STATUSES loop hashed `blobId(content)` against the ' +
      "tag's own raw blob id, genuinely independent — but on a mismatch it fell back to re-reading " +
      "BOTH sides through the identical lossy `{encoding:'utf8'}` decode (`readFileSync` upstream, " +
      '`git show` here) and comparing the decoded TEXT, so two differently-corrupted binaries that ' +
      'happen to decode to the same mangled string reported `findings: []` — proven empirically: ' +
      '`{ checked: 1, findings: [] }` over a file that had just been written corrupt. Fixed in ' +
      '#1512 (merged 2026-08-11, landed before this sweep started): content is now carried as a ' +
      'Buffer end to end and hashed as raw bytes on both sides, so there is no decode step left to ' +
      'share. This sweep additionally found and fixed a SECOND instance of the identical shape in ' +
      "the SAME file's migration-carry loop (not covered by #1512, since migrations necessarily go " +
      'through a semantic text comparison rather than a byte comparison): `tagText` (via `git show` ' +
      "'utf8') and the carried migration's content (derived from theirsDir via the same 'utf8' " +
      'decode, upstream in core-migrations.ts) could still agree wrongly if theirsDir genuinely ' +
      'diverged from the tag by two different invalid bytes that both decode to the same U+FFFD. ' +
      "Fixed by adding an independent raw-byte check (blobId against the tag's own git blob, via " +
      "theirsDir's copy) before the semantic comparison — proven fail-first: reverting only that " +
      'addition reproduces `findings: []` over genuinely-differing raw bytes ' +
      '(core-upgrade-target-fidelity.test.ts, "catches theirsDir bytes that differ from the tag ' +
      'even when both decode to the same mangled text").',
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
    independence: 'independent',
    note:
      'instance #8, reported 2026-08-08/09, STILL OPEN per the issue thread ("second occurrence — ' +
      'same day, different file"). A prefix match claims services/api/ template-owned; classify() ' +
      'cannot carry a path the template has never shipped. Needs a disagreement test that builds a ' +
      'manifest prefix with no matching template file and asserts the guard and classify() agree ' +
      "it is instance-owned (or asserts the guard fails loudly, naming the guard's own gap — either " +
      'is a fix; today neither exists, so the guard commit-blocks with an impossible instruction). ' +
      "Swept for instance-11 exposure 2026-08-11: checkCoreOwnership() reads the manifest's static " +
      'prefix list via isTemplateOwned(); classify() derives its answer from base/theirs tree ' +
      'presence in a wholly separate module (core-upgrade.ts). No shared helper, parser or decode ' +
      'step exists between them — the DISAGREEMENT itself (the honest remainder above) is the open ' +
      'problem here, not a shared-lens exposure masking one.',
  },
  {
    id: 'claim-structural-resolver',
    inClass: true,
    document: "claim.sh's closingIssuesReferences + branch-name check",
    actor: "GitHub's actual claim state under this estate's own Refs-not-Closes convention",
    disagreementTest: null,
    independence: 'independent',
    note:
      'instance #9 (#1411): a PR body saying "Refs #N" (which the DDL policy REQUIRES) populates ' +
      'neither signal claim.sh reads, so the guard reports the issue free while a PR for it is ' +
      'open. Four prior fixes (#1281, #1311, #1327, and this one) patched the same resolver; the ' +
      "issue's own 2026-08-09 comment names this as the strongest case for a structural resolver " +
      'plus its own disagreement test, neither built yet. Swept for instance-11 exposure ' +
      '2026-08-11: claim.sh fetches closingIssuesReferences/headRefName/body ONCE per PR via ' +
      '`gh pr list --json` and jq-filters the single response — no second, independently-decoded ' +
      'read of the same field to fall back on. The honest remainder is the missing disagreement ' +
      'test, not a shared-lens agreement risk.',
  },
  {
    id: 'core-direct-paths-audit',
    path: 'cli/src/lib/core-direct-paths-audit.ts',
    inClass: true,
    document: "biffo-template's own route registrations",
    actor:
      'the sibling instance actually serving the request (template routes + its own domains/<name>/ routes)',
    disagreementTest: 'cli/src/lib/core-direct-paths-audit.test.ts',
    independence: 'independent',
    note:
      'instance #9 (numbered #1428 in its own issue), reported 2026-08-10: all 9 findings on its ' +
      'first real run were false positives, because the template registers zero of the /public/ ' +
      'routes a sibling frontend calls — those are served by the INSTANCE, which the audit never ' +
      "reads. Fixed by resolveSiblingCoreSrc() (already shipped, reading biffo.sibling.json's " +
      'core_project). Disagreement test added: a synthetic estate with a template core registering ' +
      'nothing under /public/ and a resolved instance core that does — the audit disagrees (fails) ' +
      "against the template and agrees (passes) against resolveSiblingCoreSrc()'s resolved instance. " +
      'Swept for instance-11 exposure 2026-08-11: both halves are custom regex extractors over raw ' +
      'source text (extractCoreDirectPaths over TS, extractCoreRoutePrefixes over Python) — neither ' +
      "calls the other, and neither is anything close to the real actor (FastAPI's own router " +
      'registration at import time, a different language and process entirely). Genuinely ' +
      'independent, though for a different reason than the GitHub-API guards above: there is no ' +
      'mechanism available to share, since this guard and its actor do not even run in the same ' +
      'runtime.',
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
    id: 'codeql-suppression-guard',
    path: 'cli/src/lib/codeql-suppression-guard.ts',
    inClass: false,
    disagreementTest: null,
    note: 'not a two-document disagreement (#1362) — it is a comment claiming a mechanism (CodeQL suppression) that this repo has no config wiring to implement at all; there is no second document to disagree with, only a claim with nothing behind it (#1491)',
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
