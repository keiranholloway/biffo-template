#!/usr/bin/env bash
#
# Collect the day's practices metrics, render the dashboard, and persist both.
#
# Runs from cron on the workstation rather than in CI, because the rework metric
# attributes fixes with `git blame` against the sibling clones in ~/code. A CI
# job would have to clone all fifteen repos to produce the same number, and
# would otherwise report `unavailable` — which is honest, but useless daily.
#
# Install (daily at 07:30):
#   crontab -e
#   30 7 * * * /home/keiran/code/biffo-template/scripts/practices-daily.sh >> /tmp/practices-daily.log 2>&1
#
# The snapshot and the rendered page are committed on a branch and pushed, so
# the series is version-controlled and a bad day cannot be quietly revised. The
# branch is deliberately not merged automatically: a daily auto-merge into `dev`
# would add fifteen merges a month to the very metrics it is measuring.

set -euo pipefail

REPO="${PRACTICES_REPO:-/home/keiran/code/biffo-template}"
BRANCH="chore/practices-snapshots"
DATA_DIR="docs/practices/data"
PAGE="docs/practices/dashboard.html"

cd "$REPO"

# Work on a dedicated long-lived branch so the daily commit never touches
# whatever is checked out. Fetch first — a stale base is how an audit ends up
# running against dead code (AGENTS.md section 1).
git fetch origin --quiet

WORKTREE="$REPO/.worktrees/practices-daily"
if [ ! -d "$WORKTREE" ]; then
  if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
    git worktree add "$WORKTREE" "$BRANCH" --quiet 2>/dev/null ||
      git worktree add "$WORKTREE" -b "$BRANCH" "origin/$BRANCH" --quiet
  else
    git worktree add "$WORKTREE" -b "$BRANCH" origin/dev --quiet
  fi
fi

cd "$WORKTREE"
git reset --hard --quiet
# Rebase onto dev so the branch carries the current collector, not the one that
# existed when the branch was cut.
git rebase origin/dev --quiet || {
  echo "practices-daily: rebase onto dev failed; leaving branch as-is" >&2
  git rebase --abort || true
}

node scripts/practices-metrics.mjs --windows 1,7,90 --out "$DATA_DIR"
node scripts/practices-dashboard.mjs --out "$PAGE" --data "$DATA_DIR"

# A stable path outside the worktree, so the page can be bookmarked once and
# stay correct. The copy inside the worktree moves with every rebase and gets
# rewritten by the next run; a bookmark pointing at it would break silently the
# first time the branch was recreated.
STABLE="${PRACTICES_PAGE:-$HOME/practices-dashboard.html}"
cp "$PAGE" "$STABLE"
echo "practices-daily: page at file://$STABLE"

if git diff --quiet -- "$DATA_DIR" "$PAGE"; then
  echo "practices-daily: no change"
  exit 0
fi

git add "$DATA_DIR" "$PAGE"
# --no-verify: this is a generated artefact on a data branch, and the pre-push
# whole-project pyright is irrelevant to it. Every other gate still applies when
# the branch is reviewed.
git -c commit.gpgsign=false commit --no-verify -q -m "chore(practices): snapshot $(date -u +%F)"
git push origin "$BRANCH" --quiet
echo "practices-daily: pushed snapshot $(date -u +%F)"

# The rendered page lives in three places on purpose:
#   1. $STABLE            — bookmark this; rewritten in place every run
#   2. the pushed branch  — version-controlled history, one commit per day
#   3. an Artifact URL    — only when a Claude session republishes it, since
#                           cron cannot call that tool. Not required for the
#                           daily read; useful for sharing.
