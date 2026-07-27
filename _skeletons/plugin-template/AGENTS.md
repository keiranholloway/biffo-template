# Rules of Engagement for AI Agents

These rules are **binding for every automated coding agent** working in this
repository — Claude Code, Codex, Cursor, or any other. They are tool-agnostic:
express everything as plain `git` / `gh` / `pnpm` / `uv` commands. Tool-specific
guidance belongs in that tool's own file (e.g. `CLAUDE.md`), which imports this
one rather than restating it.

This is a **Biffo satellite repo** (a plugin or sibling app), separate from the
core project it extends. It follows the same engagement rules as every Biffo
repo; only its product differs.

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

## 7. CI runners — two steps this repo cannot do for itself

The workflows use `runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}`, so they
work anywhere by default and route to a self-hosted fleet when one exists. Two
things must be done **outside** this repo before its first run can succeed on a
fleet:

1. **Set the repo variable `RUNNER_LABEL`** to the fleet's label.
2. **Grant the runner GitHub App access to this repo.** The scale-up webhook only
   sees repos the App can see. Without the grant, jobs queue **indefinitely with
   no error** — and nothing in the UI distinguishes that from a slow runner. The
   first plugin repo to hit this sat queued for **1h 44m** before anyone noticed
   (`keiranholloway/biffo-runners#2`).

If a job is queued and nothing is happening, check the grant before anything
else. It is the failure that looks exactly like patience.

## 8. Security

- **Never commit secrets** (keys, tokens, credentials, `.env` values).
- **Never silently disable a security gate.** If one must be loosened, do it in
  the open and raise a tracking issue to restore it.
