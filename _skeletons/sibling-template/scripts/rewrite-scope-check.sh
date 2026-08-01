#!/usr/bin/env sh
# Refuse a force-push that has quietly started touching a file somebody else
# just changed.
#
# ## The incident (tabsii-platform#446, 2026-07-31)
#
# A branch had to be rebuilt to purge a Secret Scan finding from its history.
# The rebuild used:
#
#     git reset --soft origin/dev && git add -A
#
# `origin/dev` had advanced by two merged PRs since the branch was cut. So
# `reset --soft` moved HEAD onto the NEWER dev while the working tree still
# held the OLDER copy of a doc those PRs had edited — and `git add -A`
# faithfully staged the difference. The resulting commit, whose subject was
# about RLS policies, silently REVERTED four lines of somebody else's merged
# work.
#
# Nothing local saw it: `verify.sh` passed, 2884 tests passed, the real-Postgres
# lane passed twice. It surfaced only because GitHub reported the PR as
# CONFLICTING and somebody went looking for why. **Had those two PRs touched any
# other file, there would have been no conflict and the revert would have
# merged.** A conflict is not a detector; it is the lucky case.
#
# ## What this checks, and why it is narrow
#
# It fires only on the intersection of two conditions, because either alone is
# far too noisy to be a gate:
#
#   1. The push is a REWRITE — the remote tip is not an ancestor of what you are
#      pushing. An ordinary fast-forward push cannot have this problem.
#   2. A file the branch changes would be written back to content the
#      integration branch ALREADY HAD earlier in its history. Not new work: an
#      older copy.
#
# Condition 2 is the accidental-revert signature exactly, and it is the second
# attempt. The first asked "has the integration branch moved this file since my
# base?", which sounds equivalent and is not — `git reset --soft origin/dev`
# makes your base the integration tip, so the answer is always no. **That
# version scored a clean pass on a faithful reconstruction of the incident
# above.** `cli/src/lib/rewrite-scope-check.test.ts` reinstates it to prove the
# tests can tell the two apart.
#
# What stays silent, deliberately: amending to add a file nobody else has
# touched; rebasing onto a newer integration branch; two branches making
# genuinely different edits to one shared file. Only a STALE copy is a bug.
#
# ## What it deliberately does NOT do
#
# It does not try to decide whether a change is "intended". That needs intent,
# which no gate has. It answers a narrower question answerable from history
# alone: *is the content I am about to push actually older content?*
#
# It also never fails the push because it could not run. A guard that blocks
# work when its own inputs are missing gets disabled, and then it protects
# nothing. When it cannot answer it says so, loudly, and exits 0 — the same
# contract `verify.sh` uses for a check whose tool is absent. Absence is
# reported, never mistaken for a clean result.

set -u

ZERO=0000000000000000000000000000000000000000
ESCAPE_HATCH=BIFFO_ALLOW_SCOPE_CHANGE

note() { printf 'rewrite-scope: %s\n' "$1" >&2; }

# The integration branch every Biffo repo uses (AGENTS.md §2). Resolved rather
# than assumed: a repo whose remote HEAD says otherwise is a repo this check
# should not guess about.
integration=""
for candidate in dev main master; do
  if git rev-parse --verify --quiet "refs/remotes/origin/$candidate" >/dev/null 2>&1; then
    integration="origin/$candidate"
    break
  fi
done

if [ -z "$integration" ]; then
  note "no origin/dev, origin/main or origin/master — check did NOT run"
  exit 0
fi

# The inner filter below runs in a subshell (it is on the right of a pipe), so
# it cannot assign to a variable in this shell. Collect through a file instead.
FINDINGS_FILE=$(mktemp) || {
  note "could not create a temp file — check did NOT run"
  exit 0
}
trap 'rm -f "$FINDINGS_FILE"' EXIT HUP INT TERM

# git feeds pre-push one line per ref: <local ref> <local sha> <remote ref> <remote sha>
while read -r _local_ref local_sha _remote_ref remote_sha; do
  # Branch deletion, or nothing to push.
  [ "$local_sha" = "$ZERO" ] && continue
  # Brand-new remote branch: there is no previous scope to compare against.
  [ "$remote_sha" = "$ZERO" ] && continue
  # The remote may not have the old object locally (shallow clone, pruned).
  git cat-file -e "$remote_sha^{commit}" 2>/dev/null || {
    note "remote tip $remote_sha not available locally — check did NOT run for this ref"
    continue
  }
  # Fast-forward: not a rewrite, cannot exhibit this defect.
  if git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    continue
  fi

  new_base=$(git merge-base "$local_sha" "$integration" 2>/dev/null) || continue
  old_base=$(git merge-base "$remote_sha" "$integration" 2>/dev/null) || continue

  # Every file this branch claims to change, relative to where it forked.
  #
  # Iterated with `while read`, not `for file in $scope`: word splitting would
  # break any path containing a space, and a guard that silently skips the file
  # it should have flagged is worse than no guard. Process substitution
  # (`grep -f <(...)`) is avoided for the same class of reason — it is a
  # bashism, and this runs under `sh` from the pre-push hook.
  git diff --name-only "$new_base" "$local_sha" 2>/dev/null | while IFS= read -r file; do
    [ -z "$file" ] && continue

    mine=$(git rev-parse --quiet --verify "$local_sha:$file" 2>/dev/null) || continue
    theirs=$(git rev-parse --quiet --verify "$integration:$file" 2>/dev/null) || continue
    # Agreeing with the integration branch is the normal, safe case.
    [ "$mine" = "$theirs" ] && continue

    # The signature of an accidental revert: the content you are about to push
    # is not new work, it is a version this file ALREADY HAD earlier in the
    # integration branch's history.
    #
    # This is what makes the check work at all. The first version asked "has
    # the integration branch moved this file since my base?", which sounds
    # equivalent and is not: `git reset --soft origin/dev` makes your base the
    # integration tip, so the answer is always no and the guard never fires.
    # Verified against a reconstruction of tabsii-platform#446 — the earlier
    # condition scored a clean pass on the exact commit that reverted two
    # merged PRs.
    #
    # Bounded to recent history: an unbounded walk on a long-lived file costs
    # more than a pre-push gate should, and a stale copy older than this is not
    # the accident this catches.
    git log --format=%H -n 200 "$integration" -- "$file" 2>/dev/null | while IFS= read -r commit; do
      [ -z "$commit" ] && continue
      past=$(git rev-parse --quiet --verify "$commit:$file" 2>/dev/null) || continue
      if [ "$past" = "$mine" ]; then
        printf '%s\n' "$file"
        break
      fi
    done
  done >>"$FINDINGS_FILE"
done

findings=$(cat "$FINDINGS_FILE" 2>/dev/null)

[ -z "$findings" ] && exit 0

if [ -n "${BIFFO_ALLOW_SCOPE_CHANGE:-}" ]; then
  note "scope change allowed via $ESCAPE_HATCH:"
  printf '%s' "$findings" | sed 's/^/  /' >&2
  exit 0
fi

cat >&2 <<EOF

  This force-push would write a version of these file(s) that $integration
  ALREADY HAD earlier in its history — not new work, an older copy:

$(printf '%s' "$findings" | sed 's/^/    /')

  That is the signature of an accidental revert. A rewrite (rebase, amend,
  reset --soft) picked up a stale copy of somebody else's merged work and
  recorded it as your change. It merges silently unless it happens to
  conflict, and no test can see it — the content is valid, just old.

  Check what you are actually about to write:

    git diff $integration...HEAD -- <file>

  If it is intended, push again with:

    $ESCAPE_HATCH=1 git push ...

  If it is not: restore the file and amend —

    git checkout $integration -- <file> && git commit --amend --no-edit

  Rebuilding a branch? Reset to a FIXED SHA (the branch point), never to a
  moving ref like $integration.

EOF
exit 1
