# Feature: ownership header claims by marker only

Plan for [#1977](https://github.com/keiranholloway/biffo-template/issues/1977). The owner
replied **B** on 2026-09-23. This plan replaces the free-text parsing that #1959, #1971,
#1972, #1973, #1974 and #1977 kept patching.

**Status: proposed.** Nothing here is built. Merging this document authorises filing the
milestone issues listed under [Milestones](#milestones), and nothing else.

## Summary

`cli/src/lib/ownership-header-claim-guard.ts` finds a file's own ownership claim in two
ways:

- **The strict marker (`STRICT_MARKER`).** `INSTANCE-OWNED` and `NOT a template file`,
  matched case-sensitively. It needs no grammar rules.
- **Free text.** `SELF_REFERENTIAL_CLAIM` (the "this/it … is template-owned" pattern),
  `EM_DASH_FIRST_LINE_CLAIM`, and the helpers that try to resolve which file a pronoun
  refers to: `otherPathPrecedesBarePronoun`, `textNamesOtherPath`,
  `isSameOrAncestorPath`, `pathSegments`, `PATH_TOKEN` and `stripPathPunctuation`.

Every bug in the #1970 chain came from the free-text path. It cannot be fixed, because no
fixed-text scan can reliably work out sentence structure or what a pronoun refers to.

This plan extends the marker convention to template-owned and user-owned claims, converts
every file the guard reads a claim from today, and then deletes the free-text path.

## The marker spec (built in M1)

- **The markers.**
  - `TEMPLATE-OWNED` claims the file is template-owned.
  - `USER-OWNED` claims the file is user-owned.
  - `INSTANCE-OWNED` and `NOT a template file` stay as synonyms for `USER-OWNED`.
- **How they are matched.** Case-sensitively, as a bare token. A marker inside a code span
  (`` `TEMPLATE-OWNED` ``) does not count, because that is someone quoting the convention by
  name. The existing `(?<!`)…(?!`)` rule already does this.
- **Where they are read.** Only inside the header window the guard reads today:
  `headerRange` plus `MAX_HEADER_LINES`. That window logic does not change.
- **Two markers that disagree are an error, never a guess.** Suppose one header window has
  both a template marker and a user marker. The guard does not pick one. It fails and names
  both lines, and the author must lower-case the mention that describes a different file.
  This is the only rule that replaces the pronoun rules, and it needs no grammar. The
  author decides which file a mention is about, and the check only reads what they wrote.
- **JSON `description`.** Same markers, case-sensitive. The current case-insensitive
  `/INSTANCE-OWNED|…|template-owned/i` match is free text too, and it goes in M3.
- **Prose is not a claim.** Lower-case `template-owned` and `user-owned` stay free for
  ordinary prose. After M3 the guard never reads them.

### Why the rule for disagreeing markers is needed, measured

`TEMPLATE-OWNED` is already a de-facto marker in this repo. Three
`infra/environments/dev/*.core.tf` files open with `… — TEMPLATE-OWNED (…)`, and today's
guard misses all three, because the em-dash rule only matches lower case. But
`infra/environments/dev/core-api-environment.core.tf:10` also writes `USER-OWNED` in its
header, and there it describes `main.tf`, a different file. The uppercase form alone does
not guarantee a self-claim. Failing on disagreeing markers catches that case without
guessing.

## Success criteria (observable)

1. `sh scripts/biffo.sh check ownership-header-claim` on `dev` prints how many hits each
   mechanism produced. After M2 the free-text count is **0**, and the check still finds
   **12** claims with **0** disagreements.
2. After M3, running `git grep -nE 'SELF_REFERENTIAL_CLAIM|EM_DASH_FIRST_LINE_CLAIM|otherPathPrecedesBarePronoun|textNamesOtherPath|isSameOrAncestorPath|PATH_TOKEN|stripPathPunctuation|pathSegments'`
   on `dev` returns nothing.
3. A header that says only `This package is **user-owned**.` gives **no** claim. A header
   that says `USER-OWNED` gives a `user` claim. A header with both `TEMPLATE-OWNED` and
   `USER-OWNED` fails the check and names both lines. Fixtures in
   `ownership-header-claim-guard.test.ts` pin all three cases.
4. #1977's `./`-path bug can no longer happen: its reproduction has no marker, so the guard
   reads no claim and does not reject it as a different file. Close #1977 as superseded,
   not as fixed.

## Current state (measured against `origin/dev` 5588f93c, 2026-09-23)

**The old "~63 files" figure (and the earlier "~136") counted every mention of the words,
not what the guard enforces.** Re-running that wide grep today gives:

| measure | files |
|---|---:|
| `git grep -lE 'template-owned\|user-owned'`, whole repo | 237 |
| the same grep, limited to the six directories the guard sweeps | 167 |
| **files the real guard reads a claim from** (`sweepOwnershipHeaderClaims` run on the tree) | **9** |

Those 9, by the mechanism that finds each one:

| mechanism | file | claim | manifest says |
|---|---|---|---|
| strict marker | `scripts/verify-deployed.checks:1` | user | user |
| em-dash, line 1 | `infra/environments/dev/artifacts.core.tf:1` | template | template |
| em-dash, line 1 | `infra/environments/staging/artifacts.core.tf:1` | template | template |
| em-dash, line 1 | `infra/environments/prod/artifacts.core.tf:1` | template | template |
| "this/it is" grammar | `services/_plugins/agent-runtime/terraform/README.md:5` | template | template |
| "this/it is" grammar | `services/_plugins/agent-runtime/terraform/main.tf:4` | template | template |
| "this/it is" grammar | `services/api/src/api/domains/README.md:4` | user | user |
| "this/it is" grammar | `services/api/src/api/domains/__init__.py:4` | user | user |
| JSON description, case-insensitive | `services/_plugins/agent-runtime/biffo.plugin.json:4` | template | template |

So the conversion covers **8 files**, not 63. The other ~228 mention the words in prose
that the guard already ignores, because they are outside the header window or not a
self-claim. Converting those would add coverage the guard never had, not preserve
coverage it has. See *Deferred*.

I also simulated the M1 guard: marker-only, with `TEMPLATE-OWNED` and `USER-OWNED` added.
It picks up **3 claims no current check reads**: `infra/environments/dev/{core-api-environment,plugin-storage,plugins}.core.tf`,
and all three agree with the manifest. It also finds exactly **one** header window with
disagreeing markers: `core-api-environment.core.tf` (`TEMPLATE-OWNED` on line 1,
`USER-OWNED` on line 10 describing `main.tf`).

**Instances.** The template-owned files above reach instances through `biffo core upgrade`.
The `domains/` files are user-owned, so each instance holds its own copy, and the template
can never change it. The same guard run against the instances' local `origin/dev`
snapshots:

| instance (snapshot) | user-owned free-text claims that only the instance can convert |
|---|---|
| `tabsii-com/tabsii-platform` (local `origin/dev` 8af37e9d, 2026-09-22; live fetch refused from this session's token) | `services/api/src/api/domains/__init__.py:1`, `services/api/src/api/domains/tabsii/__init__.py:1` |
| `keiranholloway/biffo-platform` (`origin/dev` c568c67, 2026-09-08) | `services/api/src/api/domains/README.md:4`, `services/api/src/api/domains/__init__.py:4` |

**Instances pin their CLI version.** `scripts/biffo.sh` runs `npx @biffo/cli@<biffo.core.json version>`,
so an instance gets the new guard and the converted template-owned files in the same
upgrade. In each instance, the 6 template-owned claims keep the guard's count above zero,
so its refusal to report a clean result over zero files is never triggered. An
unconverted user-owned claim in an instance does not fail. It just stops being checked
once that instance upgrades past M3.

**Nothing else uses the helpers being deleted.** `isSameOrAncestorPath`, `textNamesOtherPath`,
`otherPathPrecedesBarePronoun`, `pathSegments`, `PATH_TOKEN` and `stripPathPunctuation`
are referenced only in `ownership-header-claim-guard.ts` and its test file. The
manifest-side helpers `pathspecCovers` and `matchesReleased` are **not** part of the
free-text path, and they stay.

**Nothing else is in progress here.** No open PR touches the guard, its entrypoint or
`docs/implementation/`.

## Cross-repo boundary (computed from `core-manifest.json` by longest prefix)

| path | owner | where it is built |
|---|---|---|
| `cli/src/lib/ownership-header-claim-guard*.ts`, `cli/src/scripts/check-ownership-header-claim*.ts` | `released` (`cli/`) | biffo-template |
| `infra/environments/*/artifacts.core.tf`, `…/core-api-environment.core.tf` | templateOwned (exact entries) | biffo-template |
| `services/_plugins/agent-runtime/**` | templateOwned (`services/_plugins/`) | biffo-template |
| `services/api/src/api/domains/**` | userOwned (`services/api/src/api/domains/`) | the template's own copy in biffo-template; **each instance's copy in that instance** |

The manifest answers every placement here. No placement is a choice between two sibling
product repos.

## Milestones

Each one is built by one builder and can be merged on its own. They must run in order:
M2 needs M1's marker recognition, and M3 must not delete the free-text path while
anything still depends on it.

### M1: marker spec, recognition added alongside, and a count per mechanism (biffo-template)

- Recognise `TEMPLATE-OWNED` and `USER-OWNED` in the existing strict-marker rule, next to
  `INSTANCE-OWNED` and `NOT a template file`. **Additive only:** the free-text mechanisms
  stay, so no current claim is lost.
- Add a `mechanism: 'marker' | 'free-text' | 'json'` field to `HeaderClaimHit`. The CI
  entrypoint prints the count for each after its existing total.
- Disagreeing markers in one header window fail the check, naming both lines.
- Lower-case line 10 of `infra/environments/dev/core-api-environment.core.tf`
  (`USER-OWNED` → `user-owned`) in the same PR. Without that, M1's own rule turns `dev` red.
- Write the marker spec into the guard's module doc comment, as a new section on the
  marker convention. The old history is deleted in M3, not here.
- **Reads:** `cli/src/lib/ownership-header-claim-guard{,.test}.ts`,
  `cli/src/scripts/check-ownership-header-claim{,.test}.ts`,
  `infra/environments/dev/core-api-environment.core.tf`.
- **Done when:** on the PR head, `sh scripts/biffo.sh check ownership-header-claim` prints
  `examined 12`, splits it as **marker 4 / free-text 7 / json 1**, and reports 0
  disagreements. New fixtures prove:
  - `TEMPLATE-OWNED` gives a template claim, and `USER-OWNED` gives a user claim.
  - A marker inside backticks gives nothing.
  - Both markers in one header window fail and name both lines.
  - The existing 34 guard tests still pass unchanged.

### M2: convert every file whose claim the guard reads today (biffo-template), depends on M1

- Add the matching marker to the header of these 8 files, in the same header window,
  without rewording the surrounding prose more than the marker needs:
  - `infra/environments/{dev,staging,prod}/artifacts.core.tf`
  - `services/_plugins/agent-runtime/terraform/README.md`
  - `services/_plugins/agent-runtime/terraform/main.tf`
  - `services/_plugins/agent-runtime/biffo.plugin.json` (the `description` field)
  - `services/api/src/api/domains/README.md`
  - `services/api/src/api/domains/__init__.py`
- **Reads:** those 8 files only.
- **Done when:** on the PR head the check prints `examined 12` as **marker 11 / free-text
  0 / json 1**, and the json claim now matches the case-sensitive marker. It reports 0
  disagreements. `git diff --stat` touches only those 8 files.

### M3: delete the free-text mechanism (biffo-template), depends on M2

- Delete `SELF_REFERENTIAL_CLAIM`, `EM_DASH_FIRST_LINE_CLAIM`,
  `otherPathPrecedesBarePronoun`, `textNamesOtherPath`, `isSameOrAncestorPath`,
  `pathSegments`, `PATH_TOKEN` and `stripPathPunctuation`.
- Make the JSON `description` match the case-sensitive marker.
- Remove the `free-text` value of `mechanism`.
- Delete the tests that only pin free-text behaviour: the #1959, #1971, #1972, #1973 and
  #1974 cases, at roughly lines 178–371 of the test file. Rewrite the real-corpus
  fixtures (the `domains/__init__.py`, `main.tf`, `artifacts.core.tf` and JSON cases) to
  their converted, marker-based text.
- Add one fixture showing the guard now ignores free text: a header that says only
  `This package is **user-owned**.` gives no claim.
- Rewrite the module doc comment down to the marker spec, plus a short "why not free
  text" section that points at this plan instead of repeating the five-round history.
- Update the prose that lists the four patterns in these places:
  - `cli/src/commands/check.ts:276`
  - `cli/src/lib/guard-authority-inventory.ts:190`
  - `cli/src/lib/guard-candidates.ts:326`
  - `.github/workflows/ci.yml:365`
  - the header of `check-ownership-header-claim.ts`
- **Reads:** the four guard and entrypoint files, plus the four files listed above that
  hold pattern prose.
- **Done when:** success criterion 2's `git grep` returns nothing, and the check still
  prints `examined 12` with 0 disagreements. The fixture that ignores free text passes.
  #1977 is then closed as superseded, with a pointer to this PR.

### M4: convert tabsii-platform's own user-owned claims (tabsii-com/tabsii-platform)

- Add `USER-OWNED` to the headers of `services/api/src/api/domains/__init__.py` and
  `services/api/src/api/domains/tabsii/__init__.py`.
- **Blocked until** that instance's `biffo.core.json` is on a core release that contains
  M1. Before then the marker is not recognised yet, although it does no harm. This is an
  external dependency, so it is stated in the issue body, not as a `depends-on:` label.
  It should land before the instance upgrades to a core containing M3. If it lands later,
  these two claims silently go unchecked for that gap, but nothing fails.
- **Done when:** in tabsii-platform,
  `sh scripts/biffo.sh check ownership-header-claim` lists both files as `marker` hits
  with the phrase `USER-OWNED`, and reports 0 disagreements.

### M5: convert biffo-platform's own user-owned claims (keiranholloway/biffo-platform)

- The same as M4, for `services/api/src/api/domains/README.md` and
  `services/api/src/api/domains/__init__.py`. The builder must re-measure first: the
  snapshot measured here is from 2026-09-08.
- **Done when:** in biffo-platform the check lists both files as `marker` hits, and
  reports 0 disagreements.

## Testing plan

- **Unit:** `ownership-header-claim-guard.test.ts` and `check-ownership-header-claim.test.ts`,
  covering the fixtures named in M1 and M3.
- **Real-tree:** each milestone's done-condition runs the actual CI entrypoint against the
  real `dev` tree and states its expected counts. A drop in the total (12) means the
  migration lost a claim, and it fails review.
- **Fail-first:** M1's rule for disagreeing markers is shown failing on
  `core-api-environment.core.tf` *before* line 10 is lower-cased. Commit that first, then
  apply the fix.

## Rollout

The template-owned edits and the new CLI reach instances together through
`biffo core upgrade`, because the CLI version is pinned to the core version. No
instance's check goes red at any point:

- M1 only adds.
- M2 edits comments.
- M3 only stops reading unconverted free text.

M4 and M5 keep the instances' own user-owned claims covered.

## Explicitly deferred

- **Extending coverage.** Some self-claims sit outside the guard's header window or
  sweep directories today, so the guard never reads them. Examples:
  - `scripts/error_branch_coverage.py:162`
  - `services/api/tests/test_error_branch_coverage.py:360`
  - `infra/environments/*/main.tf:70–79`
  - `apps/portal/src/lib/whoami-api.ts:22`
  - `_skeletons/*/scripts/error_branch_coverage.py`

  Adding markers there, or widening `OWNERSHIP_HEADER_SWEEP_DIRS` to `apps/` or
  `_skeletons/`, is new coverage and should be its own issue, not part of this migration.
- **The owner's call on the JSON `description`.** The plan converts
  `agent-runtime/biffo.plugin.json`'s description to say `TEMPLATE-OWNED`. If that text is
  shown in a UI and the shouty word is unwanted, the alternative is to drop JSON support
  entirely. `terraform/main.tf` and `README.md` in the same directory already carry the
  claim.
