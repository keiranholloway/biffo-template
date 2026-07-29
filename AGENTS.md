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
- **Squash-merge** by default:

  ```bash
  gh pr merge <N> --squash --delete-branch
  ```

- Squashing a **stacked** PR rewrites history, so its base disappears — retarget
  and rebase/resolve any child PRs afterward before merging them.
- Do **not** bypass a required human review you cannot satisfy. Stop and surface
  it instead of forcing the merge.

## 6. Verify post-merge CI/CD

- After merging, confirm the integration branch's CI (and any deploy workflow)
  goes green: `gh run list --branch <default-branch>` and watch the run.
- A red integration branch blocks everyone — treat fixing it as the next task.
- For **live** instances, a merge may deploy to production immediately. Verify
  the deploy succeeded.
- **A run is not guaranteed to exist.** GitHub sometimes creates no
  push-triggered run for a commit at all — on 2026-07-19 two of four
  consecutive merges here got none, while others arrived ~20 minutes late.
  Nothing distinguishes "not yet" from "never". If no run appears, re-trigger
  it via `workflow_dispatch` rather than waiting indefinitely or claiming a
  verification you did not make. Say plainly that you could not verify.

## 7. Security

- **Never commit secrets** (keys, tokens, credentials, `.env` values).
- **Never silently disable a security gate.** If a gate must be removed or
  loosened, do it in the open and raise a tracking issue to restore it.
- **Use the canonical placeholder values in fixtures.** `.gitleaks.toml`'s
  `biffo-aws-account-id` rule matches _any_ bare 12-digit number and allowlists
  only `123456789012` and `999999999999`. A plausible-looking invented account
  id fails Secret Scan. Two agents hit this in one day.
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
sh scripts/shared-sync.sh --check --estate ~/code   # report drift, exit 1 if any
sh scripts/shared-sync.sh --estate ~/code           # open a PR per drifted repo
```

It is a **one-way overwrite**, not a merge, so only add a file whose copy should
be identical everywhere — anything a repo is expected to customise belongs in
the instance manifest's three-way merge instead. Instances are deliberately out
of scope: two mechanisms writing the same paths would fight, and the
core-ownership guard would refuse the commit anyway.

**Adding a file to the shared set is not done until `--check` is clean**, the
same way a template-owned change is not done until the upgrade PRs merge.
