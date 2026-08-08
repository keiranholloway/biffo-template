#!/usr/bin/env sh
# Does the push about to happen touch the paths that make the real-Postgres
# lane matter — `db/imports/**` or a `*_pg.py` module?
#
# ## Why this exists (tabsii-platform#656)
#
# `scripts/verify.sh` already reports `pg-test` as `APPLICABLE BUT NOT RUN`
# when the repo has Postgres-dependent tests and no DSN reached it — an honest
# amber line, not a silent pass. It surfaced on a change that was ENTIRELY RLS
# policy DDL: the gate is least useful exactly where the diff most needs it,
# and a human reading a wall of green `OK` lines does not weight one amber line
# at 5pm.
#
# `verify.sh` cannot answer "is this push worth blocking over?" by itself —
# that question is about the commits being PUSHED, and a plain
# `sh scripts/biffo.sh verify` run by hand has no ref list at all. Only
# `.githooks/pre-push` sees that, on stdin, in the same
# `<local ref> <local sha> <remote ref> <remote sha>` form `rewrite-scope-check`
# reads. This script answers that one question so the hook can decide whether
# to escalate verify.sh's amber warning into a block.
#
# ## What it deliberately does NOT do
#
# It does not run the lane, provision a database, or decide whether to block —
# `verify.sh` already tries to self-provision (`scripts/biffo.sh pg-test-db`),
# and blocking is the hook's call, made by exporting
# `BIFFO_PGTEST_DIFF_RELEVANT` before `exec`ing verify. This is a narrow
# predicate: which files changed, on the paths that matter, nothing else.
#
# ## Exit codes
#
# 0 — the push touches a relevant path.
# 1 — it does not (the ordinary case; most pushes are not DDL).
# 2 — could not tell (no integration branch resolvable, no stdin, shallow
#     history). Reported on stderr and treated as "do not block" by the
#     caller, the same posture `rewrite-scope-check.sh` and `claim.sh --guard`
#     take when their own inputs are unavailable — a coordination-shaped gate
#     that fails closed on its OWN blind spot teaches people to route around
#     it, and this estate has that lesson recorded more than once.

set -u

ZERO=0000000000000000000000000000000000000000
PATTERN='(^|/)db/imports/|_pg\.py$'

note() { printf 'pgtest-diff-check: %s\n' "$1" >&2; }

integration=""
for candidate in dev main master; do
  if git rev-parse --verify --quiet "refs/remotes/origin/$candidate" >/dev/null 2>&1; then
    integration="origin/$candidate"
    break
  fi
done

# Collected through a file rather than a variable, for the same reason
# rewrite-scope-check.sh does: the read loop below cannot assign to a variable
# in the parent shell once it is fed from a pipe. One line per ref: `hit` (this
# ref touches a relevant path), `indeterminate` (could not compute its range),
# or nothing (ref checked, not relevant).
RESULT_FILE=$(mktemp) || {
  note "could not create a temp file - could not tell"
  exit 2
}
trap 'rm -f "$RESULT_FILE"' EXIT HUP INT TERM

saw_ref=0
while read -r _local_ref local_sha _remote_ref remote_sha; do
  [ -z "${local_sha:-}" ] && continue
  saw_ref=1
  # Branch deletion: nothing is being pushed.
  [ "$local_sha" = "$ZERO" ] && continue

  range=""
  if [ "$remote_sha" != "$ZERO" ] && git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
    # The ordinary case: compare against what the remote tip actually holds.
    range="$remote_sha..$local_sha"
  elif [ -n "$integration" ]; then
    # A brand-new branch, or a remote tip we do not have locally (shallow
    # clone, pruned object). Fall back to "everything this branch adds since
    # it forked from the integration branch" — the same shape a reviewer would
    # see in the PR diff.
    base=$(git merge-base "$local_sha" "$integration" 2>/dev/null) || base=""
    [ -n "$base" ] && range="$base..$local_sha"
  fi

  if [ -z "$range" ]; then
    echo indeterminate >>"$RESULT_FILE"
    continue
  fi

  if git diff --name-only "$range" 2>/dev/null | grep -qE "$PATTERN"; then
    echo hit >>"$RESULT_FILE"
  fi
done

if [ "$saw_ref" -eq 0 ]; then
  note "no ref list on stdin - could not tell"
  exit 2
fi

if grep -qx hit "$RESULT_FILE" 2>/dev/null; then
  exit 0
fi

if grep -qx indeterminate "$RESULT_FILE" 2>/dev/null; then
  note "could not resolve one or more refs' range - could not tell"
  exit 2
fi

exit 1
