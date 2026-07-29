# Standard — local gates

**Status:** adopted 2026-07-29
**Applies to:** every repo in the estate — template, instances, sibling apps, plugin repos
**Measured by:** [H4](../experiments/H4-shift-left-gates.md), `scripts/hook-audit.sh`

---

## The rule

> **Every check a repo's CI runs, that is deterministic, offline, and needs no
> credentials, must also run locally before the push — and when it cannot run,
> it must fail loudly rather than skip.**

Three properties, and all three have to hold. A gate that is missing, a gate
that is present but never executes, and a gate that skips quietly when its
tooling is absent are three different defects with the same symptom: the failure
is discovered in the pipeline.

The rule is deliberately **derived, not decreed**. The list of checks is not
maintained by hand in this document — it is read out of each repo's own
`.github/workflows/ci.yml`. A standard that has to be manually kept in step with
CI is a standard that is out of step with CI.

## Why — the measurement that motivated it

Over the **7 days** to **2026-07-29** — the estate's review window since #850 —
across the twelve repos that run CI:

| | 7 days | (30 days, for reference) |
| --- | ---: | ---: |
| CI runs | 2,768 | 4,748 |
| failed runs | 144 | 373 |
| **locally-catchable failing steps** | **132 of 199 — 66%** | 211 of 342 — 62% |

By kind, over the 7-day window:

| count | failing step | local cost |
| ---: | --- | --- |
| 47 | Test | 16s |
| 26 | Format check | 6s |
| 14 | Lint | 3s |
| 13 | Type check | 4s |
| 11 | **Core ownership guard** | already a commit hook |
| 7 | RLS-dependent tests | ~3s locally |

Nearly two thirds of everything CI caught, it caught *second*. Each costs a full
CI cycle to discover and another to confirm the fix, plus a re-entry into the
merge race.

The eleven **Core ownership guard** failures are the sharpest evidence, because
that check is *already wired as a `commit-msg` hook*. It was configured, present
in the tree, reviewed — and discovered in the pipeline eleven times, because the
hook was not running (see [Arming](#2-arming--the-hook-must-actually-execute)).

Concentration matters for expectations: 128 of the 132 are in the three instance
repos (`tabsii-platform` 64, `biffo-template` 40, `biffo-platform` 24). The
sibling and plugin repos have far fewer failures, and a larger share of theirs
are network or runner flakes this standard cannot touch.

## 1. What each hook runs

Three hooks, three jobs, ordered by how cheap they are and how early they can
speak.

### `pre-commit` — per-file, auto-fixing, sub-second

Runs `lint-staged` over **staged files only**. Every entry must *fix* rather
than merely report: at this point the correction is free, and a hook that fails
on something it could have fixed is friction with no benefit.

Minimum coverage — the file types the repo's CI format-checks:

| glob | action |
| --- | --- |
| `*.{ts,tsx,js,jsx,mjs,cjs}` | `eslint --fix`, `prettier --write` |
| `*.{json,md,yaml,yml,css}` | `prettier --write` |
| `*.py` | `ruff check --fix`, `ruff format` |
| `*.tf` | `terraform fmt` |

**The globs must cover everything CI checks.** A file type CI format-checks but
`lint-staged` does not touch is a guaranteed round trip, and it is invisible
until it happens.

### `commit-msg` — the message and the ownership boundary

- `commitlint --edit "$1"` — Conventional Commits, which the release derives the
  version bump from (ADR-0006).
- `sh scripts/biffo.sh check ownership --staged "$1"` — refuses a commit editing
  template-owned paths in an instance.

Both are cheap, and both are checks CI repeats. The eleven ownership-guard
failures above are what this hook not running looks like.

### `pre-push` — whole-project, ~40s

Runs `scripts/verify.sh`: the repo's full local-capable CI check set, in one
command, **reporting every failure rather than stopping at the first**. Stopping
early recreates the round trip in miniature — you fix one thing, push, and
discover the next.

The set is per-repo and derived from its `ci.yml`. Across the estate it is
essentially uniform:

| check | template | instance | sibling | plugin |
| --- | :-: | :-: | :-: | :-: |
| `pnpm run lint` | ● | ● | ● | ● |
| `pnpm run typecheck` | ● | ● | ● | ● |
| `pnpm run test` | ● | ● | ● | ● |
| `uv run ruff check .` | ● | ● | ● | ● |
| `uv run ruff format --check .` | ● | ● | ● | ● |
| `uv run pyright` | ● | ● | ● | ● |
| `pnpm run format:check` | ● | ● | ○ | ○ |
| `terraform fmt -check -recursive` | ● | ● | ● | — |
| `biffo.sh check plugin-terraform` / `plugin-collisions` | ● | ● | — | — |
| `pnpm run build` | — | — | ● | ● |

● = in that repo's CI, so required in its gate. ○ = **not currently in that
repo's CI either** — the sibling and plugin skeletons never gained
`format:check`, which is a gap in CI, not in the gate. Fixing it belongs
upstream in the skeletons.

### What is deliberately excluded

Every exclusion needs a written reason, because "it was slow" and "we forgot"
look identical six weeks later. Exclusions live in
`cli/src/lib/verify-parity.test.ts` and are enforced: a check in `ci.yml` that
is neither in the gate nor in the exclusion list **fails the test**.

Current exclusions:

| check | reason |
| --- | --- |
| `uv run pytest` | 56s — more than the rest of the gate combined, and it failed once in 30 days in the template. Keep in CI. |
| portal / app `build` | a full Next build |
| dependency audits, `pip-audit`, `pnpm audit` | network — advisory-database lookups |
| gitleaks | scans history, not the working tree |
| `check release-subject`, `check ownership` (CI form) | evaluate a PR that does not exist at push time |

`pytest` being excluded is a judgement, not a principle, and it is the one most
likely to be wrong. It is per-repo: a sibling whose suite runs in four seconds
should include it. The exclusion list is the place to argue that.

## 2. Arming — the hook must actually execute

**A configured hook that does not run is worse than no hook, because it is
assumed to be protecting you.** This is the failure that motivated the standard
as much as the coverage gap did.

The chain that broke it, verified 2026-07-29:

- `core.hooksPath` was `.husky/_` — a **relative** path, resolved against *each
  worktree's* root.
- Only `.husky/pre-commit`, `pre-push`, `commit-msg` were tracked. `.husky/_/` —
  the directory git actually executes — is gitignored.
- `.husky/_/` is created **solely** by `prepare: husky` on `pnpm install`.
- A fresh worktree therefore had no `.husky/_`, and git skipped every hook with
  no warning, no error, and no output.

`AGENTS.md` §1 *mandates* a fresh worktree per unit of work, so the workflow the
project requires was the workflow that disarmed its own gates. Measured across
the estate at adoption with `scripts/hook-audit.sh --estate ~/code`: **7 of 37
working trees armed — 18%**, with 5 `DEAD` and 25 never configured.

### Requirements

1. **Hooks are tracked files.** They live in `.githooks/`, are committed, and
   are executable with a shebang. A tracked file exists the instant
   `git worktree add` completes.
2. **`prepare` installs dispatchers into the repository's shared hooks
   directory** (`scripts/install-hooks.sh`) and prints that it did. Each
   dispatcher execs the running worktree's `.githooks/<name>`.

   **Not `core.hooksPath`.** That was the first fix and it does not reach far
   enough: `core.hooksPath` is a *relative* path resolved per worktree but
   stored in the *shared* config, so setting it disarms every worktree checked
   out on a branch that predates `.githooks/` — and `AGENTS.md` §1 forbids
   rebasing a worktree you did not create, so those cannot be brought forward.

   Git's default is better than the override. With `core.hooksPath` unset, a
   linked worktree runs the **common** `.git/hooks`. Verified 2026-07-29: a
   dispatcher installed once in the main checkout fired in a pre-existing linked
   worktree *and* in one created afterwards, blocking the commit in both, with
   the hook's working directory set to the worktree. One install per clone arms
   every worktree that clone will ever have — which took `biffo-template` from
   6 armed of 10 to **10 of 10**, without touching a single branch.

   A dispatcher with no `.githooks/<name>` to run **warns on stderr and exits
   0**. That branch has no repo-defined hooks, which is the state it was already
   in; blocking every commit there would invent a gate it never had and break
   other agents mid-flight. But it never does it quietly.
3. **Failure is loud.** A hook whose tooling is missing must exit non-zero. It
   is correct for a hook to fail with `Command "lint-staged" not found` — that
   is a repo telling you to install. It is never correct for it to skip.
4. **Arming is audited, not assumed.** `scripts/hook-audit.sh` reports every
   working tree as `ARMED`, `DEAD` or `NO-HOOKS` and **exits non-zero on any
   `DEAD`**, because `DEAD` is the state that lies to you.

### The one escape hatch

`BIFFO_SKIP_VERIFY=1 git push`, for when you mean it. Deliberately an explicit
environment variable rather than `--no-verify`: it leaves a decision in the shell
history, and it skips only the pre-push gate rather than silently skipping every
hook. Its usage rate is a counter-metric in H4 — a gate everyone bypasses has
failed, and that has to be visible rather than inferred.

## 3. Verifying a repo complies

```bash
sh scripts/gate-coverage.sh --estate ~/code   # does each gate mirror its own CI?   <- headline
sh scripts/hook-audit.sh --estate ~/code      # will the hook actually fire?
sh scripts/shared-sync.sh --check --estate ~/code   # is every repo on the current gate?
pnpm run verify                               # does this repo pass right now?
```

Four questions, four commands, and **the order matters**: coverage first,
because it is the only one that measures the thing the standard is for.

Arming and drift are **prerequisites**, not results. A hook that does not
execute makes coverage unachievable; a hook that executes and checks nothing
makes it look achieved. On 2026-07-29 arming read **100%** while six repos ran
**one check in eight** — `tabsii-crm` took a 700-line TypeScript-and-Python
change, ran `terraform-fmt`, and printed `verify passed`. Reporting arming as
the headline is what let that stand.

Each of the three estate commands **exits non-zero** when it finds a problem, so
they can gate something rather than be read.

## Distribution

`.githooks/*`, `scripts/verify.sh` and `scripts/hook-audit.sh` are template-owned
exact files in `core-manifest.json`, so `biffo core upgrade` carries them to
instances. Sibling and plugin repos are separate repos an upgrade never reaches;
they get the standard by vendoring it into `_skeletons/sibling-template/` and
`_skeletons/plugin-template/` (every newly scaffolded repo) plus a one-time
copy-in for the existing ones — the same split every user-owned-repo artefact
uses.

The hooks directory itself is **not** owned. Owning it would make an upgrade
propose deleting a hook an instance legitimately added — the #279 part-1 trap.
Each wired hook is an exact-file entry.
