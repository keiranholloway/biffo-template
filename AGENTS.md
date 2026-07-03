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

## 7. Security

- **Never commit secrets** (keys, tokens, credentials, `.env` values).
- **Never silently disable a security gate.** If a gate must be removed or
  loosened, do it in the open and raise a tracking issue to restore it.

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
