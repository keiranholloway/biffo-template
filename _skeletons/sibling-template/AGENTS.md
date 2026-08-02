# Rules of Engagement for AI Agents

These rules are **binding for every automated coding agent** working in this
repository — Claude Code, Codex, Cursor, or any other. They are tool-agnostic:
express everything as plain `git` / `gh` / `pnpm` / `uv` commands. Tool-specific
guidance belongs in that tool's own file (e.g. `CLAUDE.md`), which imports this
one rather than restating it.

This is a **Biffo satellite repo** — a repository in the estate that is not a
core project: a sibling app, a plugin, a shared package, a runner fleet, or a
design/data repo. It follows the same engagement rules as every Biffo repo; only
its product differs. `CLAUDE.md` says which one this is.

This file is distributed by the template and kept in step by
`scripts/shared-sync.sh` there (`shared-files.json`). Edit it **upstream in
`biffo-template`**, not here: a local edit is overwritten by the next sync, and
`AGENTS.md` silently drifting 68 lines behind is why that mechanism exists
(biffo-template#559, #1150).

## 1. One integration branch: `dev`

- **`dev` is the integration branch** — you branch from it and open every PR back
  into it; `gh repo view --json defaultBranchRef` confirms it. If it reports
  anything other than `dev`, flag it rather than working around it. (A sibling app
  also carries `staging` and a reserved `main`/production branch as promotion
  targets — production not built yet; a plugin repo has `dev` only. Either way you
  work off `dev`.)
- **All changes land via PR.** No direct commits to `dev`, no force-pushes to it.
  Branch protection stays on.
- Never leave the primary checkout parked on a feature branch or let it fall
  behind — keep it on `dev`, no more than a `git fetch` behind, and do the work
  in worktrees (§2).

## 2. Work in an isolated worktree

- **Always start from a freshly-fetched `dev`:** `git fetch origin`, then
  `git worktree add .worktrees/<name> -b <type>/<slug> origin/dev`. Never branch
  from a stale local ref.
- **Install dependencies in the new worktree before working** — `uv sync` and/or
  `pnpm install`, so the local gates (pre-push checks, lint-staged) run against
  fresh deps, not a stale `.venv`/`node_modules`.
- **One worktree per unit of work**, under the git-ignored `.worktrees/`.
- **Clean up when the PR merges:** `git worktree remove .worktrees/<name>`, then
  let the branch be deleted. Keep `git worktree list` short and every entry live.

## 3. Commits

- **Conventional Commits** (`feat`, `fix`, `chore`, `docs`, `test`, `infra`,
  `security`, `refactor`, `perf`, `ci`), enforced by commitlint.
- Tag your commits with your agent's own `Co-Authored-By:` trailer.
- Keep commits and PRs **scoped to one concern**.

## 4. Pull requests

- Link the issue the PR resolves (`Closes #N`) and describe what changed and why.
- Mark a PR **ready** (not draft) when it is meant to merge.
- Behavior changes ship **with tests**. Don't reduce coverage to make CI pass.

## 5. Merging — never merge red

- Get CI green and confirm it: `gh pr checks <N>`. A green local run is not
  sufficient — verify the actual PR checks.
- **Wait with `scripts/wait-for-checks.sh`, not a hand-rolled loop:**

  ```bash
  sh scripts/wait-for-checks.sh <N>   # 0 green · 1 failed · 2 cannot tell
  ```

  Do not write your own `until … grep -c pending … done`. That polls for the
  **absence** of pending checks, so the empty window right after
  `gh pr update-branch` — superseded runs dropped, new ones not yet registered —
  reads as "all green" and merges a PR whose CI has not started. The script
  waits on a **positive** signal instead, and its **exit 2 means "cannot tell",
  which is never a pass**.

- **Squash-merge, delete the branch, remove the worktree:**
  `gh pr merge <N> --squash --delete-branch`.

## 6. Push honestly, and verify the remote has your commit

- **Push with the exit status visible:** `git push origin HEAD; echo $?`. A pipe
  (`git push | tail`) reports the pipe's status, not git's — a rejected push then
  reads as success and the commit is silently lost. Never trust a "pushed"
  message printed unconditionally after a pipe.
- **Confirm the remote actually has the commit before relying on it,** especially
  before merge: `git log origin/<branch> -1`. A green PR page is not proof your
  latest local commit reached it.

## 7. Security

- **Never commit secrets** (keys, tokens, credentials, `.env` values).
- **Never silently disable a security gate.** If one must be loosened, do it in
  the open and raise a tracking issue to restore it.
