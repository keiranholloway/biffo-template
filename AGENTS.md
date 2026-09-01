# Rules of Engagement for AI Agents

These rules are **binding for every automated coding agent** working in this
repository — Claude Code, Codex, Cursor, or any other. They are tool-agnostic:
express everything as plain `git` / `gh` / `pnpm` / `uv` commands. Tool-specific
guidance belongs in that tool's own file (e.g. `CLAUDE.md`), which should import
this one rather than restate it.

This file is the single source of truth. If a tool-specific file disagrees with
it, this file wins.

## 1. Work in an isolated worktree

- Never edit the primary checkout directly. Create a dedicated git worktree per
  unit of work, under the repo-local `.worktrees/` directory:

  ```bash
  git worktree add .worktrees/<short-name> -b <branch> origin/<default-branch>
  ```

- `.worktrees/` is git-ignored and excluded from every linter/type-checker, so
  worktrees never get committed or double-scanned. Keep it that way when you add
  tooling.
- **Always start from a freshly-fetched integration branch.** `git fetch origin`
  first, then branch from `origin/<integration>` — never from a stale local ref.
  A primary checkout that had drifted 10 commits behind `main` once produced a
  whole audit against dead code (it "found" a feature missing that had shipped
  weeks earlier). When in doubt, `git fetch` and confirm `git rev-list --count
HEAD..origin/<integration>` is `0` before trusting a tree.
- **Install dependencies in the new worktree before working** — `uv sync` and
  `pnpm install`. The local gates run against whatever is installed here: the
  whole-project `pyright` in `.husky/pre-push`, and `lint-staged` at commit time.
  A stale post-upgrade `.venv` once made `pre-push pyright` fail and git reject a
  push — the failure was then masked (§4) and the commits were squash-merged
  missing.
- **Clean up when the PR merges.** Remove the worktree, then let its branch be
  deleted:

  ```bash
  git worktree remove .worktrees/<short-name>
  ```

  Note: `gh pr merge --delete-branch` cannot delete a branch that is still
  checked out in a worktree — remove the worktree first (or delete the branch
  after).

- **Hygiene.** Keep `git worktree list` short and every entry live: once a PR
  merges, `git worktree remove` it and delete its branch, and periodically
  `git worktree prune` and clear merged local branches. Stale worktrees and dead
  branches pile up into exactly the confusion this section exists to prevent.

### Working alongside other agents

Several agents often run concurrently in this repo. A worktree isolates your
**files**; it does not isolate everything.

#### Check before you start, and push early

**Before starting work on an issue, run:**

```bash
sh scripts/biffo.sh claim <issue-number> --as <token> [-R owner/repo]  # 0 free · 1 taken · 2 cannot tell
sh scripts/biffo.sh claim <issue-number> --release <token>             # only the holder may clear it
```

**`--as <token>` is required, and there is no untokened form** (#1562). The
token is opaque, identifies a **session** rather than a person, and is not a
secret — it appears in a public comment. Shape it `<what>-<MMDD>-<unique>`, e.g.
`tpl-groom-0813-9f2a`; anything with two `-`-separated parts and 6+ characters
is accepted, and a role word every session would share (`agent`, `bot`, `me`) is
refused. Omit the flag and the refusal prints a ready-made token derived from
your branch, so the fix is one line to copy.

It asks four questions, because the answer lives in more than one place: does
the issue carry the `in-progress` label, is there an **open PR** referencing it,
is there a **remote branch** naming it, and has a PR already merged that closes
it. If it reports free, it claims the issue for you — label and dated comment
together, so the claim can later be recognised as stale.

**Exit 2 is "cannot tell" and is never "free".** An unreadable issue or an
unauthenticated `gh` must stop you, not wave you through.

**Why four signals rather than the label alone.** The label is a
hand-maintained second copy of something git already knows: a branch exists, a
PR exists. Those are automatic — you cannot do the work without creating them —
while the label is a separate action someone has to remember, in a workflow that
may never have been told to. Second copies of a decision drift; that is the same
lesson as `_extract_detail`, as `AGENTS.md` itself (#559), and as the commit-msg
type list.

On 2026-08-03 four sessions collided in one morning. **Three of the four were
"work exists, label does not"** — a live worktree or a merged PR, on an issue
nobody had labelled. The fourth was the reverse: a label with no work, while
another session built the thing and opened a PR. Checking only the label would
have caught one of four.

**Why the token is not optional.** A claim records when and who, and every
session on a workstation claims under the same GitHub actor — so without a token
a delegated agent cannot tell your reservation from a stranger's, and the rule it
correctly follows is _never steal a fresh claim_. On 2026-08-04 four agents were
dispatched onto pre-claimed issues; the one that checked before starting refused
and produced nothing, while the three that had not yet checked worked normally.
Whether a delegate works or stalls should not depend on when it happens to look.

`--as` shipped for that in #1279 and was **optional**, so the default went on
losing the deciding information silently. On 2026-08-13 it appeared zero times in
the `AGENTS.md` of every satellite in the estate, and two concurrent sessions in
one repo produced four claims that could not be told apart — ownership had to be
reconstructed from a local command log, and for one pair could not be established
at all. That is why it is now required rather than recommended (#1562).

Claim with `--as`, give the same token to every agent you dispatch, and release
with `--release <token>` — which refuses to clear anybody else's claim, and is
what makes a stale label distinguishable from a live one.

**Push your branch as soon as it exists.** The claim is a reservation; the
branch is the evidence, and it is the only signal other machines can see — a
local worktree is invisible estate-wide. The window between starting and pushing
is where collisions actually happen: one of that morning's issues went from
branch to **merged in three minutes**, which no protocol could have caught.

**Release what you claim** — `claim <issue-number> --release <token>`, which
refuses to clear anybody else's. Release when the PR merges, when you close the
issue, or when you stop — including when you stop because someone else got
there first. A claim you never release is worse than no claim, because the next
session believes it. If you are skipping something because it is claimed, check
how old the claim is: an `in-progress` issue with no activity for over an hour is
probably abandoned. Steal it deliberately and say so in a comment; never steal a
fresh one.

**A PR that promises an issue stays claimed must reaffirm it, not just say
so.** The release rule above is unconditional — merge, close, or stop — and
prose alone cannot carve out an exception to it: PR #1848 stated, in its own
body, that nothing in it would touch issue #1083's claim, and the same
session's ordinary end-of-session release removed the label 21 seconds later
anyway (#1849). The written promise and the actual mechanism disagreed, and
nothing reconciled them. If a PR is a `Refs`, not a `Closes`, and genuinely
means to keep its issue claimed past this session's own lifetime — a
multi-day review window, for instance — do not run `--release` as the last
step. Run `--reaffirm <token>` instead: it re-applies the `in-progress` label
and posts a claim comment exactly as a fresh claim would, except that it
asserts the claim is staying rather than asking whether it is free, and it
refuses to overwrite a claim a different token already holds. A step that
actually runs is what makes the promise true; a sentence describing what will
not happen is not.

**This applies to every workflow, not just backlog grooming.** It used to live
in one agent skill, which is why the sessions doing the work — running an
ordinary change, a build, a fix — had never been told about it. That is the same
shape as §3's Conventional Commits being binding on seventeen repos and enforced
in three (#1193).

**`git push` now enforces the branch/PR half of this (#1231 instance 2).**
Claiming was advisory — nothing ever ran it for you, so the fix for a
collision was itself subject to the collision it fixes. `.githooks/pre-push`
derives the issue number from the branch name and refuses the push if another
remote branch or another open PR already names it. It deliberately checks
neither the `in-progress` label nor identity (see above for why), and it
excludes the branch being pushed so pushing your own branch twice cannot block
you. A branch that names no issue is skipped silently. If the gate cannot tell
— no network, `gh` unauthenticated — it warns and lets the push through rather
than blocking: this is a coordination gate, not a correctness one, and every
collision on 2026-08-03 was caught before duplicate work merged, so a miss here
is recoverable in a way a blanket block on push is not. Set
`BIFFO_CLAIM_STRICT=1` to make cannot-tell block instead. A real conflict names
what it found and points back here — "steal a claim over an hour stale, with a
comment" applies to a pre-push block exactly as it does to `claim.sh` itself.

- **`git stash` is shared across all worktrees.** A bare `git stash pop` pops
  whatever is on top of the _repository's_ stack — which may be another
  session's uncommitted work, in files you never touched. This has already
  happened here. Prefer committing to your own branch over stashing; if you
  must stash, use `git stash push -m "<your branch>"` and pop by name, and
  never assume `stash@{0}` is yours.
- **There is no core version to claim.** A `core.version` file used to be
  bumped by every template-owned change, so concurrent PRs collided on it by
  design and the loser rebased and re-bumped. Since #423 the version is derived
  on merge (ADR-0006) from the highest `core-v*` tag and the squash-merge
  subject — your PR title, which CI requires to be a Conventional Commits
  subject. Nothing in the tree names a version, so there is no shared file to
  conflict on and no number to coordinate over.
- **Do not remove or modify a worktree you did not create.** Pulling the ground
  out from under a running agent breaks it mid-flight.

## 2. Branch from, and PR into, the integration branch (`dev`)

- Branch from the integration branch and open your PR back into it. It is `dev`
  in every Biffo repo (see below); `gh repo view --json defaultBranchRef`
  confirms it.
- Name branches by intent, tied to an issue where one exists:
  `feat/…`, `fix/…`, `docs/…`, `chore/…`, `ci/…`, `refactor/…`.
- **All changes land via PR.** No direct commits to the integration branch, no
  force-pushes to it. Branch protection stays on.

**The integration branch is `dev` in every repo** — template, instances, sibling
apps, and plugin repos alike. You always branch from and PR into `dev`.
`gh repo view --json defaultBranchRef` is authoritative; a repo whose default is
anything other than `dev` has not yet been migrated (issue #559) — flag it rather
than working around it.

**This is now enforced, not just asked for.** `scripts/protection-audit.sh` fails
on a repo with no `dev` branch (#1145). It previously _skipped_ one, which is a
different and worse thing: the repo left the denominator entirely, so
`27 branches checked, all protected and binding` was a true statement about a set
that silently excluded the repos least likely to be protected. Four — the two
runner fleets, the data-model design repo and `tabsii-map` — sat on an
unprotected `main` for weeks while two separate audits (#714, #1052) reported the
estate fully bound, because both asked _"is `dev` protected here?"_ and a repo
answering 404 was dropped rather than failed. All four were migrated in #1145 and
the audit now reports **34** branches where it reported 27.

The general shape, worth recognising elsewhere: **a check that skips an input it
cannot evaluate is not neutral — it shrinks its own scope and reports the
remainder as the whole.** That is the same defect as `staging` being absent from
the audit's branch list (#1057), one level further out.

Deployable repos (instances and sibling apps) additionally keep `staging` and
`main` as promotion targets — `dev` → `staging` → `main`, where `main` is
**production**. Production is not built yet, so `main` is **reserved and
currently unused**; it is not a working branch, so never branch from it or open a
PR against it. Non-deployable repos (this template, plugin-code repos) publish to
npm or mount into the host rather than deploy to environments, so they have `dev`
only.

- **Never leave a primary checkout parked on a feature or upgrade branch, and
  never let one fall behind.** Keep the primary on `dev`, no more than a
  `git fetch` behind, and do the actual work in worktrees (§1) — not in the
  primary. A primary left sitting on a stale `core-upgrade` branch is how an
  audit gets run against dead code and how pushed-looking commits get lost.

## 3. Commits

- **Conventional Commits**, enforced by commitlint. The authoritative type list
  and rules are in `commitlint.config.js`; follow it (`feat`, `fix`, `chore`,
  `docs`, `test`, `infra`, `security`, `refactor`, `perf`, `ci`).
- Tag your commits with your agent's own `Co-Authored-By:` trailer so authorship
  is auditable. Each tool uses its own identity.
- Keep commits and PRs **scoped to one concern**. If you must unblock yourself
  with an unrelated fix, prefer a separate PR; if that's impractical, call it out
  explicitly in the PR body.

## 4. Pull requests

- Link the issue the PR resolves (`Closes #N`) and describe what changed and why.
- Mark a PR **ready** (not draft) when it is meant to merge.
- Behavior changes ship **with tests**. Don't reduce coverage to make CI pass.

### Read your own diff for the fail-open shape

`biffo-workflow`'s Step 4.5 ("read your own diff before you open the PR") asks
whether the _justification_ was checked. This is its sibling, for a question
Step 4.5 does not ask:

> **If this reported success, or reported zero, because it could not see its
> input — would anything look different?**

For any change that reports a count, a status, or an exit code: name what a
real failure would look like, and confirm it is distinguishable from the empty
case.

This paragraph is a pre-registered, falsifiable experiment
(`docs/practices/experiments/H7-fail-open-authoring-gate.md`, issue #1083),
not an assumed-effective rule. If the review at that experiment's review date
finds it did not move the metric, this paragraph comes back out rather than
accumulating.

### Fixing a bug: reproduce the actual failure, not a theory of it

A green test suite proves your test passes. It does **not** prove the reported
bug is fixed, and the two are only the same thing if your test observes the
failure the reporter saw.

- **Reproduce the failure before fixing it**, by the route the reporter used.
  If you cannot reproduce it, you do not yet know what you are fixing.
- **Verify the fix by that same route.** For anything that only manifests in a
  running deployment — client-side routing, CDN behaviour, auth flows,
  infrastructure — a passing unit test is not evidence. Say so in the PR rather
  than implying verification you did not perform.
- **Do not close an issue you have not seen fixed.** Land the fix, then confirm
  against reality, then close.

This is not hypothetical. Issue #275 (portal navigation landing on the raw RSC
payload) was diagnosed from source, "fixed", shipped with a drift guard, and
closed — on a wrong cause. The suite was green, the reasoning looked sound, and
the bug was untouched. It survived a full teardown and redeploy before a human
clicked the link and found it. The issue's own text had said to verify by
clicking a deployed portal; that instruction was written and then not followed.

The corollary: when a fix cannot be verified locally, batch it into a
deploy/verification cycle and be explicit about what remains unproven, rather
than treating merge as completion.

### Checking exit status through a pipe

`cmd | tail` reports `tail`'s status, not `cmd`'s — a failing command reads as
success. Use `${PIPESTATUS[0]}`. This masked two real failures in one session,
including a `teardown` that reported success while destroying nothing.

### Push honestly, and verify the remote has your commit

A push can fail and still look like it worked, and commits have been lost this
way. `.husky/pre-push` runs the whole-project `pyright`; against a stale `.venv`
(deps not re-synced after an upgrade — §1) it errors and git **rejects the
push**. Combined with the piped-exit trap above, the rejection reads as success,
and the dropped commits get squash-merged missing.

- **Push with the exit status visible:** `git push origin HEAD; echo $?`. Never
  trust a "pushed" message printed unconditionally after a pipe.
- **Confirm the remote actually has the commit before you rely on it** —
  especially before merging: `git log origin/<branch> -1`, or `git show
origin/<branch>:<path>` for a specific change. A green PR page is not proof
  your latest local commit reached it.

## 5. Merging — never merge red

- Get CI green yourself and confirm it — run `gh pr checks <N>` and wait for all
  required checks to pass. A green local run is not sufficient evidence; the
  agent verifies the actual PR checks.
- **Wait with the CLI's `wait-for-checks`, not a hand-rolled loop:**

  ```bash
  sh scripts/biffo.sh wait-for-checks <N> [-R owner/repo]   # 0 green · 1 failed · 2 cannot tell
  ```

  Satellites no longer carry their own copy: `scripts/biffo.sh` resolves the
  version-pinned CLI and runs the canonical script that ships inside the
  package (#1109). This repo keeps `scripts/wait-for-checks.sh` because it is
  the source that gets packaged, not a distributed copy.

  Do not write your own `until … grep -c pending … done`. That polls for the
  **absence** of pending checks, so the empty window right after
  `gh pr update-branch` — superseded runs dropped, new ones not yet registered —
  reads as "all green" and merges a PR whose CI has not started. It is the
  estate's dominant failure shape (a gate passing because it cannot run) in the
  agent's own tooling, and it happened here on 2026-08-02. The script waits on a
  **positive** signal instead: every required context concluded, or (where
  protection is unreadable) at least one check present, all concluded, and the
  count stable across two polls. **Exit 2 is "cannot tell" and is never a pass.**

- **Squash-merge** by default:

  ```bash
  gh pr merge <N> --squash --delete-branch
  ```

- Squashing a **stacked** PR rewrites history, so its base disappears — retarget
  and rebase/resolve any child PRs afterward before merging them.

### If you were dispatched by another agent, you do NOT wait and you do NOT merge

Everything above assumes the session doing the work is also the session that
will merge it. **A delegated subagent is not that session.** If an orchestrator
spawned you to do one unit of work, your finished state is:

> branch pushed → PR opened → **report back immediately**, with the PR number
> and what you changed.

Do **not** run `wait-for-checks`. Do **not** merge. The orchestrator watches CI
and merges, and sends you back if CI fails on your change.

**Why this is a rule and not a preference.** A subagent has no way to sleep. Told
to wait for CI, it stops, wakes, re-reads the same pending status, and stops
again — and every wake is a full context reload that reports nothing new.
Measured on 2026-08-11: one dispatch tranche produced **25+ wake-ups** returning
only "still waiting"; a single agent burned ~145k tokens re-reading a queued
deploy before it was killed. The orchestrator does the same wait for nothing
extra — it is already awake, and one loop covers every PR in the tranche at once
instead of N agents each paying a context reload for the same minutes.

**The instruction is the cause, so the fix lives here.** Both incidents happened
in sessions whose dispatch briefs ended "get CI green, then squash-merge" —
written by an orchestrator that had _already recorded the lesson_ and then
followed §5 above, which says exactly that. §5 is right for the session that owns
the work and wrong for a delegate, and until now nothing said so. Recording the
cleanup ("kill the looping agent") never stopped it, because the loop was being
commissioned rather than stumbled into.

**Keep a delegate alive only when it still has a DECISION to make** — a real test
failure to diagnose, a design question to answer. "Wait, then merge" is not a
decision.

Orchestrators: end every dispatch brief with the finished state above, and reach
for `gh pr merge --auto` when the merge needs no judgement — then still verify,
because `--auto` waits for ever on a check that cannot re-evaluate itself (a
`Release Guards` closing-keyword failure needs a re-run, not a wait).

- Do **not** bypass a required human review you cannot satisfy. Stop and surface
  it instead of forcing the merge.
- **`--auto` waits forever on a required check that cannot re-evaluate itself.**
  `gh pr merge --auto` queues the merge and returns immediately — it does not
  watch anything, so a PR can sit indefinitely with six of seven checks green
  while the seventh needs an action nobody has taken. The `Release Guards`
  closing-keyword failure is the recorded case (#1319): the fix is a PR-body
  edit, and — before `release-guards.yml`'s trigger gained `edited` — a body
  edit alone never re-ran the check, only `gh run rerun <run-id> --failed` did.
  If you arm `--auto`, still watch it with `wait-for-checks` rather than
  assuming "queued" means "will finish".

## 6. Verify post-merge CI/CD

- After merging, confirm the integration branch's CI goes green:
  `gh run list --branch <default-branch>` and watch the run.
- **Check the whole branch with the CLI's `branch-health`, not a run list:**

  ```bash
  sh scripts/biffo.sh branch-health [-R owner/repo]   # 0 green · 1 red · 2 cannot tell
  ```

  It reports the latest run of **every** workflow on the integration branch, so
  the deploy cannot fall off the bottom; and when something is red it names the
  **first** failing commit, not the newest — see the attribution point below.
  Exit 2 is "cannot tell" and is never a pass, same convention as
  `wait-for-checks.sh`.

- **Why a run list is not enough.** The deploy is a different workflow and a
  short list does not show it — an instance runs five workflows on a merge
  (`CI`, `CodeQL`, `Core Version Tag`, `Deploy Application`, `RLS Tests`), and
  `gh run list --limit 3` returns three that are **not** the deploy. If you are
  checking by hand, name the workflow:

  ```bash
  gh run list --workflow "Deploy Application" --branch <default-branch> --limit 1
  ```

  On 2026-08-02 this cost **2h25m**: a merge broke the deploy at 10:43, "dev CI
  green" was reported truthfully several times from a short run list, and the
  failure was found 1h53m later — after four further merges had each failed
  their own deploy on damage they had not caused. A red deploy has no audience,
  because the author who caused it has already moved on.

- A red integration branch blocks everyone — treat fixing it as the next task.
  That includes a red **deploy**: every subsequent merge fails too, and the
  failure is attributed to whoever merged last rather than to whoever broke it.
  **Check whether the branch was already failing before diagnosing your own
  change** — `branch-health.sh` answers this directly, printing
  `has been failing since <sha>` and telling you plainly when that is not your
  commit. On 2026-08-02 four people each diagnosed their own innocent change
  because nothing did.
- For **live** instances, a merge may deploy to production immediately. Verify
  the deploy succeeded.
- **A run is not guaranteed to exist — but check `mergeable` before you conclude
  that.** When no checks appear on a **pull request**, the first question is not
  "did the trigger fire?" but "can GitHub compute this merge at all?":

  ```bash
  gh pr view <N> --json mergeable --jq .mergeable   # CONFLICTING · MERGEABLE · UNKNOWN
  ```

  `CONFLICTING` means GitHub cannot build a merge commit, so it creates **no
  check runs whatsoever** — and none will ever arrive until the branch is
  rebased. `workflow_dispatch` does not help, because nothing is missing a
  trigger. On 2026-08-03 PR #1243 sat for over ten minutes printing
  `Waiting on 5 required check(s)` for exactly this reason (#1246);
  `wait-for-checks` now reads the field itself and exits 2 with the cause, so
  you should rarely have to. `UNKNOWN` is transient — GitHub returns it while
  computing mergeability, especially right after a push — so wait it out rather
  than treating it as a verdict.

  Only once mergeability is clean is the genuine no-run case in play: GitHub
  sometimes creates no push-triggered run for a commit at all — on 2026-07-19
  two of four consecutive merges here got none, while others arrived ~20 minutes
  late, and nothing distinguishes "not yet" from "never". That is when you
  re-trigger via `workflow_dispatch`, rather than waiting indefinitely or
  claiming a verification you did not make. Say plainly that you could not
  verify.

  The general shape: **before re-running something that produced no output, ask
  whether it was ever able to run.** Re-triggering a job that cannot start
  reproduces the wait, not the answer.

### A dependency audit is time-dependent — a red with no tree change is a registry event

`pnpm audit` and `pip-audit` ask **live** advisory sources. Their verdict is a
function of what had been ingested at that instant, not only of the tree. Two
runs of the **same commit**, minutes apart, can legitimately disagree — this
happened repeatedly on 2026-08-03 while two advisory waves landed, and a green
was nearly banked as evidence a repo was clean (#1269).

Two consequences worth knowing before you go hunting:

- **A red that appears with no tree change is not a colleague's merge.**
  `branch-health` will correctly name the first failing commit, and that commit
  can be entirely innocent. Check the audit line's timestamp before attributing
  it to a change.
- **`dev` being green is not evidence `dev` is clean** — only that nothing had
  been ingested when it was last asked.

So every audit line now states **what it saw and when**:

```
pnpm audit (workspace: .): 0 critical, 0 high across 978 package(s)
  (0 moderate, 2 low — reported, not blocking); registry answered 2026-08-04T05:18:48Z.
```

That is falsifiable; a bare "no advisories" was not. Severities below the
blocking threshold are printed too, so a tree that is _clean_ and a tree that is
_merely under the threshold_ stop looking identical.

**An audit that cannot run BLOCKS, and exits 2.** "Could not determine" is a
different fact from "found a real advisory" (exit 1), so do not go looking for a
vulnerability when you see a 2 — find out why the tool could not run. This was
`exit 0` until #1269, and `biffo-plugin-ideation` rode that path on every run:
`pip-audit` was never declared, so its Python dependencies had never been
scanned and the check was permanently green.

## 7. Security

- **Never commit secrets** (keys, tokens, credentials, `.env` values).
- **Never silently disable a security gate.** If a gate must be removed or
  loosened, do it in the open and raise a tracking issue to restore it.
- **Use the canonical placeholder values in fixtures.** `.gitleaks.toml`'s
  `biffo-aws-account-id` rule matches any word-bounded 12-digit number and
  allowlists only `123456789012` and `999999999999`. A plausible-looking
  invented account id fails Secret Scan. Two agents hit this in one day.
- **A UUID fixture is not exempt, and its exemption lives in the rule's own
  regex plus a narrowly-scoped allowlist, not in line-level context.** The
  rule matches any bare 12-digit run, including the last segment of an
  ordinary fixture UUID (e.g. `11111111-1111-1111-1111-111111111111`) —
  correct test code, tripped by coincidence, and the obvious "fix the value"
  response does not clear it (see next bullet). Three attempts were needed;
  read all of them before touching this rule again, because the first two
  each looked reasonable and were each prosecuted and broken against the real
  binary:
  - #893's `(?:^|[^0-9A-Fa-f-])(\d{12})\b` blanket-excluded any preceding
    hyphen, which also silently stopped catching the most common real-world
    leak shape — an account id at the end of a hyphenated resource name
    (`my-app-artifacts-<id>`, `deploy-role-<id>`; S3 buckets, IAM roles, ECR
    repos and log groups routinely end that way).
  - #1628 attempt 1 required the word before the hyphen to contain a non-hex
    letter, which failed on real AWS naming: the hex class `[0-9A-Fa-f]`
    includes all ten digits, so any date- or version-stamped prefix
    (`backup-2024-<id>`, `snapshot-2023-<id>`) or English word spelled only
    in `a`-`f` (`facade-<id>`, `decade-<id>`) escaped undetected — a UUID
    segment and a date are the same string, so there is no way to tell them
    apart by looking at the word alone.
  - #1628 attempt 2 inverted the approach — broad rule (`\b\d{12}\b`) again,
    with a rule-level allowlist matching a **complete** UUID shape
    (`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
    and `regexTarget = "line"`, reasoning that the reported secret (via
    `secretGroup`) is only the 12 digits and never the hyphens the UUID shape
    depends on, so the allowlist had to see the whole line to recognise it.
    This closed every gap the first attempt left and correctly exempted a
    UUID on its own line, but `regexTarget = "line"` suppresses the _whole
    line_ — so a genuine account id sharing a line with any unrelated UUID
    (a log line with both a request-id and an account id, a JSON telemetry
    blob, a comma-separated pair) was silently waved through with it.
    Reproduced live: `"account <account-id> request
11111111-1111-1111-1111-111111111111"` produced zero findings.

  Attempt 3 (current) inverts the exclusion's _scope_ instead of tuning the
  heuristic again. A UUID's final 12-digit segment is always preceded by
  exactly two 4-character hex groups (its 3rd and 4th RFC-4122 fields) —
  `backup-2024-<id>` has only one hex quad before it, and "backup" isn't hex
  at all. RE2 has no lookbehind, so that prefix is consumed as an optional,
  non-capturing alternation in the **rule's own regex**, and only the 12
  digits are reported via `secretGroup`:
  `\b(?:[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-)?(\d{12})\b`. The leading `\b` is
  deliberate, not inherited by habit — without it the digit capture has no
  constraint on what precedes it when the optional prefix doesn't match, so
  it can match a 12-digit substring embedded inside a longer digit run (a
  16-digit blob) that the original `\b\d{12}\b` never flagged; confirmed by
  experiment.

  The exclusion itself lives in a **separate** allowlist scoped to
  `regexTarget = "match"` (gitleaks supports `[[rules.allowlists]]`, plural,
  independently scoped per entry), tested against the anchored shape
  `^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-\d{12}$`. Critically, `"match"` tests the
  **raw regex match** (the two hex quads plus digits), not the
  `secretGroup`-narrowed secret — established by direct experiment against
  the real 8.30.1 binary with a rule regex built so the two texts differ,
  which is what neither previous attempt's own testing distinguished (#1628
  attempt 2's rule had no such gap, so its match and its secret were always
  identical text, and its conclusion that `"match"` tests the secret was true
  only by coincidence of not being able to tell the two apart). Because the
  allowlist is scoped per **match** rather than per **line**, attempt 2's
  failure mode is closed structurally: an account id and an unrelated UUID on
  the same line each produce their own match with their own full-match text,
  so only the UUID's is excluded. `deadbeef-<id>` (the residual gap attempt
  1's word heuristic accepted) is also closed — it is not part of a real
  two-hex-quad prefix, so it is no longer exempt.

  The residual trade-off, narrower than either previous attempt's: a bare
  account id preceded by exactly two complete, hyphen-separated 4-hex-digit
  groups that are _not_ part of a real UUID (e.g. `"0000-0000-<id>"` with
  nothing else around it) is indistinguishable from a UUID tail here. That
  requires an author to write two complete fake hex quads immediately before
  a bare account id with no other context — narrower than a single hex-spelled
  word or a date prefix, and no case in this repo does it. If you hit this
  rule on a value that is not a complete two-hex-quad-preceded shape, that is
  very likely a real finding — do not add an allowlist entry to make it pass
  (see below).

- **Secret Scan reads git history, not just your diff.** Fixing the value at
  your branch tip is not enough — the finding survives in the earlier commit.
  Rewrite the branch (amend or squash) and force-push. Force-pushing your own
  topic branch is fine; only the integration branch is protected (§2). Never
  fix a scan failure by editing the allowlist.

## 8. Live instances — never teardown

- Never teardown/redeploy a live environment to ship a change. Port changes
  **non-destructively via PR** into the instance's integration branch.

## 9. Template → instance distribution

This template is upstream of the instances scaffolded from it. When a change must
reach an instance, honor the ownership boundary declared in `core-manifest.json`:

- **Template-owned paths** (e.g. `services/api/`, `cli/`, `packages/`,
  `modules/`, `.github/`): distribute via `biffo core upgrade`, which opens a PR
  in the instance. It fail-closes on paths it doesn't own.
- **User-owned paths** (e.g. `apps/`, `infra/`, `services/`): `biffo core
upgrade` will not carry these. Distribute via a **manual PR copy-in** to the
  instance.

When in doubt about a path, check `core-manifest.json` before choosing the
mechanism.

### Sibling and plugin repos: `scripts/shared-sync.sh`

`biffo core upgrade` reaches **instances only** — they carry `biffo.core.json`
and a `core-manifest.json`. Sibling apps and plugin repos are separate
repositories with neither, and the channel to them used to be "vendor it into
the skeleton, plus a one-time manual copy-in for existing ones".

**That is not a mechanism.** The skeleton only helps repos created afterwards,
and nothing ever prompts the copy-in. It cost this estate twice:

- `AGENTS.md` drifted 68 lines behind in tabsii, missing the very workflow
  guardrails the template had already written (#559).
- Eight repos ran a local gate two versions old. `tabsii-crm` checked **one**
  thing in eight on a 700-line change and printed `verify passed` (#855).

Files every sibling and plugin must hold verbatim are listed in
`shared-files.json` and distributed by `scripts/shared-sync.sh`:

```bash
sh scripts/shared-sync.sh --check --estate ~/code        # report drift, exit 1 if any
sh scripts/shared-sync.sh --estate ~/code                # open a PR per drifted repo
sh scripts/shared-sync.sh --candidates --estate ~/code   # unlisted paths worth triaging; always exits 0
sh scripts/shared-sync.sh --backfill --estate ~/code     # skeleton files older repos never got; always exits 0
sh scripts/shared-sync.sh --skeleton-adoption --estate ~/code  # skeleton paths not held by EVERY applicable repo; always exits 0
```

`--candidates` and `--backfill` are the two discovery directions and neither is
a gate. `--candidates` walks the **satellites** and asks what many repos hold
that the manifest does not govern; it requires a path in ≥5 repos, so it is
structurally blind to a file the skeleton gained recently. `--backfill` walks
the **skeletons** and asks what some of a skeleton's repos have and others lack
— which is the drift #1109 recorded, where four frontend helpers sat in the
newest sibling and in none of the four older ones because improving a skeleton
only ever helps repos scaffolded afterwards.

`--backfill` reports **partial adoption only**. A path every applicable repo
holds is fine; a path no applicable repo holds is scaffolding they were meant to
consume or rename. Between them is the gap. It also considers only repos
carrying an actual marker: `skeletonDefault` exists so `filesFromSkeleton` can
deliver `AGENTS.md` to the runner fleets and the design repo, **not** as a claim
that those repos are siblings, and comparing them against a full sibling
skeleton invents `services/api/*` gaps in repos that will never hold one.

`--skeleton-adoption` is a third mode, and the fix for the class `--candidates`
is structurally blind to (#1271): a path the skeleton gained recently, which
few or no siblings have adopted yet, is exactly the case `--candidates`'s ≥5
threshold hides — the fewer repos that hold it, the less visible it is. This
mode has no threshold, because it does not sample, it **enumerates**: the
skeleton's own file list is known, so for every path it owns it counts holders
across the applicable repos and reports any not held by **all** of them —
including a path held by zero, which `--backfill` deliberately treats as
scaffolding but which here is the loudest possible adoption signal. "Repo
skeleton" is discovered the same way
`cli/src/lib/skeleton-governance-workflows.test.ts` discovers it: a directory
under `_skeletons/` that ships `.github/workflows/ci.yml`, not a hardcoded name
list — `_skeletons/registry/` is plugin-registry content, never scaffolded into
a repo, and is excluded by that test. Some of what it reports is deliberate
(`auth-gate.tsx` is intentionally per-app; `apps/frontend/src/app/example/**`
is scaffolding meant to be deleted) and it does not guess which — that split is
recorded by hand, not inferred from the path. Advisory only, like the other two
— and since #1271 it **ratchets**: `shared-files.json`'s `skeletonAdoption`
records `<skeleton>:<path> -> holder count`, and the mode exits 1 when a count
falls **below** its baseline, or when a new unadopted skeleton path has no
baseline at all. Pre-existing residue never blocks — same posture as
`mustBeUniform` and the orphan ratchet — and a count that _improves_ is reported
with an instruction to lower the baseline, because a ratchet that never tightens
stops meaning anything.

Paths a skeleton declares in its `.scaffold-tokens.json` are reported separately
as **template payload**: `biffo plugin create` rewrites `example_plugin` to the
new plugin's package name, so `src/example_plugin/main.py` becomes
`src/idea_scout/main.py` and **0 adoption is correct**. Deleting them would break
scaffolding outright — there would be nothing left to rename. The token list is a
deliberate second copy of `plugin-scaffold.ts`'s substitution table, kept honest
by `cli/src/lib/scaffold-tokens-parity.test.ts`, which asserts the two agree in
both directions.

It is a **one-way overwrite**, not a merge, so only add a file whose copy should
be identical everywhere — anything a repo is expected to customise belongs in
the instance manifest's three-way merge instead. Instances are deliberately out
of scope: two mechanisms writing the same paths would fight, and the
core-ownership guard would refuse the commit anyway.

**Adding a file to the shared set is not done until `--check` is clean**, the
same way a template-owned change is not done until the upgrade PRs merge.

#### It is not only hooks and scripts

The set began as governance plumbing — `.githooks/*`, `scripts/verify.sh`, the
dependency audits — and for a long time that was all it held. That framing is
part of why #1107 propagated: `handleResponse` threw the whole response body as
the error message, a user saw `{"detail":"Administrator access required"}`
where a page's content belonged, and the identical function sat in the skeleton
and in **all seven** sibling repos with no channel to any of them. "Add it to
the shared set" was never considered, because the shared set was understood to
be about gates.

**The test is not what kind of file it is. It is whether every repo's copy
should be identical, and whether they diverge in practice.** Application source
qualifies when both are true: `apps/frontend/src/lib/api-client.ts` is the
first, and it is there now.

#### Six lists, and the difference matters

- **`files`** — a plain list of paths, distributed to every repo in scope and
  **created where absent**, from this repo's copy at the **same path**. Right
  for a gate every repo must run. Wrong for anything layout-specific: it would
  write a frontend API client into plugin repos, runner repos and a design repo
  that have no frontend at all.
- **`filesIfPresent`** — a `target → canonical source` map, kept in step only
  in repos that **already hold** the file, never created. The two paths differ
  because a sibling's `apps/frontend/...` has no counterpart at this repo's
  root, so the **skeleton** is the canonical copy.
- **`filesFromSkeleton`** — a `path → policy` map for files whose canonical
  copy is in the **skeleton matching the receiving repo's flavour**, resolved
  from its marker via `skeletonForMarker` (repos with neither marker, selected
  by the `scripts/verify.sh` clause, fall back to `skeletonDefault`). The
  policy says what happens to a copy the repo **already has**: `sync`
  overwrites it, `seed` leaves it alone forever. Both create where absent.
- **`mustBeUniform`** — a `path → baseline variant count` map for **whole
  files** that should read **identically** across every repo that holds them.
- **`overridesFloor`** — a `target → canonical source` map that checks only
  the override **keys** inside `pnpm.overrides`, in one direction: a repo may
  declare extra overrides, but must not be **missing** one the canonical copy
  declares.
- **`keyMustBeUniform`** — a `file → dotted key path → baseline variant
count` map for a **subtree** of a file that should read identically even
  though the file as a whole legitimately differs per repo.

`mustBeUniform`, `overridesFloor` and `keyMustBeUniform` are the three lists
that **never write** — `scripts/shared-sync.sh --check` only measures them and
reports; nothing is copied or overwritten. See below for why.

The mechanism can backfill — that is what `files` and `filesFromSkeleton` are.
`filesIfPresent` is how you say a file must not be created, only kept current,
because putting a file into a repo that never had one is a decision somebody
should make rather than a side effect of adding a line to a manifest.
`mustBeUniform` is how you say a file's copies must converge, without deciding
_to_ which one — a one-way overwrite cannot do that safely, and pretending it
can is how a fix gets clobbered by the copy that lacks it.

#### Why the third list exists, and when to reach for it

`AGENTS.md` and `CLAUDE.md` were **absent from eleven of seventeen** estate
repos — not a stale copy, nothing (#1150). An agent opening `tabsii-crm` got no
worktree discipline, no honest-push rule, no never-merge-red and no
reproduce-before-fixing; one merged three PRs there having read another repo's
copy to find out the rules. Neither existing list could fix it: `files` creates
but cannot remap a path, and the satellite ruleset is **not** this repo's root
`AGENTS.md` (that one carries §9, `core-manifest.json` and the upgrade flow —
none of which applies to a satellite); `filesIfPresent` remaps but never
creates, which is the whole job.

Teaching `files` the `target → source` map form would have been the smaller
change, and it does not work here, for two reasons that are properties of the
content rather than of the mechanism:

1. **The source is not one file.** `_skeletons/plugin-template/AGENTS.md`
   differs from the sibling one by 50 lines of birth-time branch-protection and
   runner-grant checklist (#714, written because both plugin repos ran with no
   branch protection at all). A single source would delete that from the plugin
   repos or force it into every sibling — and `shared-files-parity.test.ts`
   requires every `files` entry byte-identical in **every** skeleton, which
   these two must never be.
2. **The two files need opposite policies on an existing copy.** `AGENTS.md`
   must be kept in step; it drifting 68 lines behind is #559. `CLAUDE.md` must
   not be: its load-bearing content is the `@AGENTS.md` import, but it also
   carries a per-repo "What this repo is" paragraph, and four of the repos
   backfilled are not sibling apps at all — overwriting it would assert in each
   of them that they are.

So: reach for `filesFromSkeleton` when the canonical copy is a skeleton's rather
than this repo's **and** the file must be created where absent. Use `seed` when
the repo is expected to own the file after it arrives, `sync` when it must never
diverge. Note what `seed` does to `--check`: a **missing** copy is drift, a
**differing** one is not — that is the ownership `seed` grants, and reporting it
otherwise would redden the check permanently in the repos that did the right
thing.

#### Why the fourth list exists, and when to reach for it

`_extract_detail` was written twice, independently, in two different siblings,
fixing the same bug — because the second author had no way to discover the
first had already solved it (#1107, closed; the class issue is #1108). A sweep
alone cannot fix this: variant count alone cannot tell "should be uniform" from
"legitimately per-repo". `apps/frontend/src/lib/auth.ts` sits beside
`api-client.ts` at 6 variants across 7 repos, and `apps/frontend/src/app/page.tsx`
sits at 7 variants across 7 repos — the first is a defect (#1117), the second is
every sibling's product surface working as intended. The discriminator is
semantic, not statistical, so it has to be **declared** — which is what
`mustBeUniform` is for.

It cannot be `files` or `filesIfPresent`: both are one-way overwrites, and a
file that has already diverged has no channel to record that divergence short
of destroying five-sixths of it on no evidence about which copy is correct.
`mustBeUniform` tracks the debt so it can be reconciled deliberately, rather
than either staying invisible or getting clobbered by accident.

`--check` fails a path only when its **live** variant count **exceeds** the
baseline recorded for it — never on the pre-existing residue. This is the same
posture `biffo.orphan-baseline.json` established for the core-upgrade orphan
ratchet (`cli/src/lib/core-upgrade.ts`, `checkOrphanRatchet`): a guard that is
red on day-one residue every morning trains people to stop reading it
(`scripts/protection-audit.sh` makes this case at length), and `--check` feeds
exactly that daily dashboard (`scripts/practices-daily.sh`). A path whose
variants drop _below_ baseline is reported as improved and told to lower the
baseline — a ratchet that never tightens stops meaning anything.

**It reads `origin/<base>` refs, never a working tree.** The first pass at
measuring the estate for this feature read `api-client.ts` at 4 variants from
local working trees and 1 from remote refs — the difference was a stale
`git pull` on the measuring machine, not anything real in the estate. A guard
that fails on somebody's stale checkout is a fail-closed nuisance people learn
to ignore, which is the opposite of the point.

`auth.ts` is declared on **security grounds**, not merely because it differs:
seven divergent authentication implementations are seven surfaces to audit
independently. Its job is entirely plumbing — Cognito pool resolution, session
retrieval, credential hygiene, sign-in/out mechanics — with no app-specific
policy in it, so there is no category of legitimate per-app difference for it
to hold. Per-app variation belongs in `auth-gate.tsx` instead (present in 3 of
7 siblings, deliberately **not** in `mustBeUniform` — declaring it would be the
opposite error, since gating which Cognito groups an app admits is exactly
where apps are meant to differ).

**Reconciled 2026-08-03 (#1117), and the superset rule needs a correction.** It
said any reconciliation must converge to the **superset** of exports, on the
grounds that collapsing to the smallest copy would delete
`tabsii-marketplace`'s registration. That is right about marketplace and wrong
about everyone else: `tabsii-geo` and `tabsii-intake` also exported
`signIn`/`signOut`/`completeNewPassword`, and **nothing called them** — no
page, component, hook or e2e test, verified repo-wide at `origin/dev`. They
were a second login path in the security-critical file, which the skeleton's
own docstring forbids, kept alive only by the tests written for them.

So the answer was neither superset nor intersection. Six repos converged to the
**skeleton's** shape (the dead exports deleted, and #1190 bringing runtime
identity resolution to the five that lacked it), and marketplace keeps a
**declared, permanent divergence** because its `signIn`/`signUp`/`confirmSignUp`
are live behind a public self-service flow — collapsing to the smallest copy
would delete that feature
outright. See `mustBeUniformNote` in `shared-files.json` for the full evidence
trail and the rest of the seeded entries.

#### Why the fifth and sixth lists exist, and when to reach for each

`pnpm.overrides` in `apps/frontend/package.json` is how the estate pins a
transitive dependency above a security advisory. Nothing distributed it:
`biffo core upgrade` reaches instances only, and `shared-files.json`'s other
lists all treat a file as one indivisible unit — `mustBeUniform` measures a
whole file's blob SHA, which is exactly wrong here, because
`apps/frontend/package.json`'s `name`/`version`/`dependencies` are
legitimately per-repo while `pnpm.overrides` must not be. Adding the whole
file to `mustBeUniform` would report every sibling as diverged on the parts
that are supposed to differ; adding it to `files`/`filesIfPresent` would
overwrite `name`, `version` and every sibling's own dependencies on the next
sync.

Two occurrences, 2026-08-08, are why this could not wait. `nanoid` (#1352): a
CVE fix landed in this repo's root and skeleton at 06:22Z; by 07:00Z all six
live siblings were still on the vulnerable version, their required audit check
red, every open PR in every one of them blocked — and they were only fixed
because unrelated work happened to hit the wall 38 minutes later. Nothing
would have surfaced it otherwise. `undici` (#1367): measured at several
different upper bounds across the estate, including outright absence in one
sibling (`tabsii-intake`).

The class has **two symptoms**, and one list does not cover both. `nanoid` is
absence — a repo silently missing a key the canonical copy has. `undici` is
divergence — every repo but `tabsii-intake` already had the key, they simply
disagreed about its value. **`overridesFloor`** was built first, the same
morning, for the absence half: it compares override **keys** in one direction
— extra is fine, missing is the defect — and its first real run correctly
flagged `tabsii-intake` as `MISSING: undici@<7.29.0`. It does not, and by
design cannot, see two present values disagreeing: it never reads the
override's _value_, only whether the key exists. **`keyMustBeUniform`** is the
sixth list, built for exactly that gap — the value at a key path, canonicalised
(object keys sorted recursively, so field order cannot manufacture a false
variant) and compared across every repo that holds the file, with absence
folded in as one more disagreeing value rather than a separate signal. A repo
that holds the file but lacks the key is a holder with a variant, the same way
a repo that holds the file with the "wrong" value is — so `overridesFloor`'s
`tabsii-intake` finding and `keyMustBeUniform`'s report of it corroborate
rather than duplicate.

Key path segments are dot-separated plain object traversal; see
`keyMustBeUniformNote` in `shared-files.json` for the one constraint that
follows from that (no segment may itself contain a literal dot, true of every
entry declared so far).

**`keyMustBeUniform` stays measure-only, and that is still deliberate.** The
short version is that `mustBeUniform`'s own reason (a one-way overwrite
destroys evidence about which copy is right) applies at smaller blast radius
to a key than to a whole file, but it still applies. Measuring
`pnpm.overrides` as a whole subtree once surfaced an undeclared `sharp`
bound-style divergence (`^0.35.0` in three siblings, `>=0.35.0` in three
others) — **reconciled 2026-08-08 by hand across six PRs (#1380/#1381)**, not
by a writer inventing a winner. `--check` now reports `apps/frontend/
package.json#pnpm.overrides` and `#engines` **uniform across 6 repos**, the
first entry in either ratchet to reach a genuinely closed state. That
reconciliation retired precondition (1) of the three `keyMustBeUniformNote`
lists for safe writing (reconcile the current divergence by hand first); (2)
merge rather than overwrite, and (3) confidence the JSON write does not
produce a reformatter diff, were never about _this_ divergence specifically
and stay open for the next one `keyMustBeUniform` finds.

**`overridesFloor` gained a writer anyway (#1352, 2026-08-09) — deliberately
narrower than what `keyMustBeUniform` was withholding.** `scripts/
shared-sync.sh --deliver-overrides` calls a new `apply_overrides_floor()`
function that adds a key the canonical copy declares and a holder is
**missing entirely**, and never touches a key the holder already has,
whatever its value. That restriction is why it does not reopen the risk
`keyMustBeUniformNote` describes: the risk is scoped to a key that is
_present_ with a value that might be wrong, and there is no such key to get
wrong when the key is simply absent. It writes via a textual splice — only
new lines inserted after `"overrides": {`, nothing else in the file touched
or reformatted — verified by re-parsing the result before it is written,
which is precondition (3) made structural rather than merely promised. It
closes the `nanoid`/`js-yaml` shape this section leads with; it does not
touch the `undici`/`sharp` shape, which stays exactly where
`keyMustBeUniform` already puts it. **It is dry-run only in this version** —
every run stages a real worktree, applies and verifies the splice, reports,
and discards it, but never pushes and never opens a PR. Wiring up real
delivery is follow-up work with its own review, not something this change
claims to have proven safe.

#### Reconcile before you distribute

A one-way overwrite destroys whatever it lands on. Before adding a path to
`files` or `filesFromSkeleton`:

1. **Diff every copy** and classify each difference — a fix the canonical copy
   is missing, genuine per-repo customisation, or drift.
2. **Fold the fixes upstream.** `tabsii-crm` had added a `patch` verb to its
   client; the canonical copy took it, so crm converged with nothing lost.
   `_extract_detail` was written twice in two siblings and never brought
   upstream, which is why three more still ship the bug it fixes.
3. **Do not add a path you have not reconciled — declare it in
   `mustBeUniform` instead.** `auth.ts` was the worked example: it sat in all
   seven siblings diverging 29–247 lines, and a one-way overwrite would have
   clobbered six repos on no evidence about which behaviour was right (#1117).
   Tracking it rather than distributing it is what made the reconciliation
   possible. It is now **2 variants across 7 repos** — six byte-identical to
   the skeleton, plus `tabsii-marketplace`'s declared divergence — and it
   **still is not distributed**, because `filesIfPresent` is a one-way
   overwrite with no per-repo exclusion and would delete marketplace's public
   registration. A reconciled path is not automatically a distributable one.
4. **Expect the rehearsal to find callers, not just the file.** Adding `patch`
   broke the skeleton's own test mock, and `tabsii-geo` has the same uncast
   mock in two places — so that repo needs a one-line fix landed _with_ the
   file, not after it. Phase 1 runs each target's own gate before anything
   ships, and refuses the whole round if any repo fails; that is the point.
