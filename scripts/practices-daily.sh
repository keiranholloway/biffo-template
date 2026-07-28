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

# cron has no ssh-agent, and these keys are non-default names — so without this
# every remote operation fails with "Permission denied (publickey)" at 07:30 and
# the snapshot silently never reaches GitHub. Both keys are offered because the
# collector fetches the tabsii-com clones as well as this one; ssh tries each in
# turn. Set PRACTICES_SSH_KEYS to override.
#
# Verified by running the whole script under `env -i` with a cron-like PATH.
if [ -z "${GIT_SSH_COMMAND:-}" ]; then
  _keys="${PRACTICES_SSH_KEYS:-$HOME/.ssh/id_github_key $HOME/.ssh/id_github_key_tabsii}"
  _ssh="ssh"
  for _k in $_keys; do
    [ -f "$_k" ] && _ssh="$_ssh -i $_k"
  done
  export GIT_SSH_COMMAND="$_ssh -o IdentitiesOnly=yes -o BatchMode=yes"
fi

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
#
# `-X theirs` is load-bearing, and it is the fix for a failure that ran silently
# for weeks. The snapshot files this branch commits (`$DATA_DIR/*.json`, `$PAGE`)
# also exist on `dev`, because the branch has been merged there before. A plain
# rebase therefore hits a content conflict on every single run, forever. In a
# rebase, "theirs" is the commit being replayed — this branch's snapshot — which
# is exactly the side that should win: `dev`'s copy is a stale point-in-time
# import, the branch's is the live series.
#
# The old code caught that failure, logged to stderr, and CARRIED ON. That is
# what made it invisible: the collector still ran, the dashboard still rendered,
# the snapshot still pushed, and cron still exited 0 — while the tree was frozen
# 45 commits behind. The job had been producing its numbers with the #701-era
# collector, missing #703, which *changed how merges are classified*. Metrics
# that look fine and are computed by superseded definitions are worse than
# metrics that are missing.
#
# So a failure here is now fatal. There is no safe way to continue: every step
# below runs the wrong code and writes a plausible-looking result.
git rebase -X theirs origin/dev --quiet || {
  git rebase --abort >/dev/null 2>&1 || true
  echo "practices-daily: rebase onto dev failed — refusing to run against a stale tree." >&2
  echo "  The collector and dashboard below would be the versions from" >&2
  echo "  $(git log -1 --format=%h) rather than current dev, and would produce" >&2
  echo "  numbers that look correct and are not. Resolve the branch by hand." >&2
  exit 1
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

if git diff --quiet -- "$DATA_DIR" "$PAGE" docs/practices/sessions.jsonl; then
  echo "practices-daily: no change"
  exit 0
fi

git add "$DATA_DIR" "$PAGE" docs/practices/sessions.jsonl 2>/dev/null || git add "$DATA_DIR" "$PAGE"
# --no-verify: this is a generated artefact on a data branch, and the pre-push
# whole-project pyright is irrelevant to it. Every other gate still applies when
# the branch is reviewed.
git -c commit.gpgsign=false commit --no-verify -q -m "chore(practices): snapshot $(date -u +%F)"
# --force-with-lease because the reset above rewrites this branch every run.
# `--force-with-lease` rather than `--force`: if someone else has pushed to the
# branch, fail loudly instead of discarding their commit silently.
git push origin "$BRANCH" --force-with-lease --quiet
echo "practices-daily: pushed snapshot $(date -u +%F)"

# Nudge, if the ground truth is going stale. Every headline figure on the page is
# inferred from commit types and repo names; a session log is the only thing that
# can falsify that inference, and it is the one part nobody can automate. A rule
# with nothing watching it stops being followed silently — that is how nine
# orphan worktrees accumulated under a documented hygiene rule.
# The effort log lives outside the repo so appending never dirties the primary
# checkout, and so a PR is not needed per entry. Copy it onto the snapshot
# branch here, which is what version-controls the history.
EFFORT="${PRACTICES_EFFORT_LOG:-$HOME/.practices-sessions.jsonl}"
# `|| true` matters under `set -e`: a bare `[ -f x ] && cp` is a compound whose
# status is the test's, so on a machine with no effort log yet this line would
# abort the whole script — after the push, so the day's work would land and the
# job would still report failure.
{ [ -f "$EFFORT" ] && cp "$EFFORT" docs/practices/sessions.jsonl; } || true

NUDGE="$(node scripts/practices-session.mjs --nudge --file "$EFFORT" || true)"
if [ -n "$NUDGE" ]; then
  echo "$NUDGE"
  # Desktop notification when a session bus is reachable. Fully optional: cron
  # usually has no DISPLAY, and a failed notify must never fail the job.
  if command -v notify-send >/dev/null 2>&1 && [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    notify-send "Practices" "$NUDGE" >/dev/null 2>&1 || true
  fi
fi

# The rendered page lives in three places on purpose:
#   1. $STABLE            — bookmark this; rewritten in place every run
#   2. the pushed branch  — version-controlled history, one commit per day
#   3. an Artifact URL    — only when a Claude session republishes it, since
#                           cron cannot call that tool. Not required for the
#                           daily read; useful for sharing.
