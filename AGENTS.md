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
- **Clean up when the PR merges.** Remove the worktree, then let its branch be
  deleted:

  ```bash
  git worktree remove .worktrees/<short-name>
  ```

  Note: `gh pr merge --delete-branch` cannot delete a branch that is still
  checked out in a worktree — remove the worktree first (or delete the branch
  after).

### Working alongside other agents

Several agents often run concurrently in this repo. A worktree isolates your
**files**; it does not isolate everything.

- **`git stash` is shared across all worktrees.** A bare `git stash pop` pops
  whatever is on top of the _repository's_ stack — which may be another
  session's uncommitted work, in files you never touched. This has already
  happened here. Prefer committing to your own branch over stashing; if you
  must stash, use `git stash push -m "<your branch>"` and pop by name, and
  never assume `stash@{0}` is yours.
- **Never edit `core.version`.** It is derived after merge from your PR's
  conventional-commit type and committed by the release job (issue #423), so a
  PR that sets it fights the automation and CI refuses it. It used to be bumped
  by hand, which made concurrent PRs collide on one line every time — and never
  actually checked the number went up, so a revert could restore an
  already-published version (#422).
- **Your PR title decides the released version.** Squash-merge makes it the
  commit subject, and the release job reads that subject: `feat` earns a minor,
  everything else a patch, and a declared break (`feat!:`) a minor while the
  template is pre-1.0. A title the derivation cannot parse fails CI rather than
  releasing something arbitrary.
- **Do not remove or modify a worktree you did not create.** Pulling the ground
  out from under a running agent breaks it mid-flight.

## 2. Branch from, and PR into, the repo's default branch

- Determine the integration branch with `gh repo view --json defaultBranchRef`.
  It differs per repo (this template uses `main`; some instances use `dev`).
  Branch from it, and open your PR back into it.
- Name branches by intent, tied to an issue where one exists:
  `feat/…`, `fix/…`, `docs/…`, `chore/…`, `ci/…`, `refactor/…`.
- **All changes land via PR.** No direct commits to the integration branch, no
  force-pushes to it. Branch protection stays on.

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
