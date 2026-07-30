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

# Terminate the log deliberately, so a truncated run is distinguishable from a
# complete one.
#
# `~/.practices-daily.log` is append-only across runs, and until now a run that
# died in the middle looked exactly like one that finished: the last line was
# whatever it happened to reach. A `set -e` abort printed nothing at all.
#
# That ambiguity is not hypothetical — it cost real time on 2026-07-30, when a run
# piped into `head` took SIGPIPE and its truncated log was misread as evidence of
# a bug in this script's exit status. The script was fine; the log could not say
# so. A marker is the difference between "it finished" and "this is where I
# stopped reading".
#
# An EXIT trap rather than an `echo` at the bottom: this fires on the early
# `exit 0` (nothing to commit), on every `set -e` abort, and on any exit path
# added later. A line at the bottom would cover only the one path that reaches it
# — which is the same "guard that protects one caller, not the class" shape this
# scoreboard keeps recording.
#
# Caveat worth stating: a SIGPIPE'd run is killed rather than exiting, so the trap
# may not fire. Cron redirects to a file, not a pipe, so the real path is covered;
# an interactive `| head` is not, and that is the case that caused the confusion.
_finish() {
  _rc=$?
  if [ "$_rc" -eq 0 ]; then
    echo "practices-daily: DONE $(date -u +%FT%TZ)"
  else
    echo "practices-daily: ABORTED rc=$_rc $(date -u +%FT%TZ)" >&2
  fi
}
trap _finish EXIT

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

# cron has no unlocked keyring either, and that is the *same class* of bug as the
# ssh-agent one above — a credential that exists only inside a desktop session.
#
# `gh auth login` stores its token in the GNOME keyring when one is available;
# `~/.config/gh/hosts.yml` then carries no `oauth_token` at all. Cron has no
# session D-Bus to reach the keyring through, so every `gh api graphql` call
# returns `HTTP 401: Requires authentication`.
#
# This is not hypothetical: on 2026-07-30 all fifteen repos 401'd, the collector
# wrote a snapshot in which every repo was `unmeasured` and `estate.merges` was
# 0, and the dashboard was never re-rendered — so the bookmarked page silently
# showed the previous day. It had worked 24 hours earlier, which is exactly what a
# session-dependent credential looks like.
#
# GH_TOKEN takes precedence over the keyring, so a 0600 file is enough. Kept out
# of the repo and out of `hosts.yml`; set PRACTICES_GH_TOKEN_FILE to override.
if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  _tokfile="${PRACTICES_GH_TOKEN_FILE:-$HOME/.config/biffo/gh-token}"
  if [ -r "$_tokfile" ]; then
    GH_TOKEN=$(tr -d '[:space:]' < "$_tokfile")
    export GH_TOKEN
  fi
fi

# Preflight, and it must be fatal.
#
# Every metric here degrades gracefully by design: a repo that cannot be read is
# recorded as `unmeasured` and excluded from the aggregates rather than
# contributing a zero. That is right for one repo and wrong for all of them —
# "nothing could be measured" is not a data point, it is a broken job, and the
# 2026-07-30 run proved that the graceful path will happily produce a
# publishable-looking file containing no data.
#
# So: fail here, loudly, before anything is written. A cron job that dies with a
# reason in the log is recoverable; one that writes an empty snapshot over a good
# one is how a series quietly acquires a hole.
if ! _whoami=$(gh api user -q .login 2>&1); then
  echo "practices-daily: FATAL — gh cannot authenticate, so nothing can be collected." >&2
  echo "practices-daily: $_whoami" >&2
  echo "practices-daily: cron has no keyring; put a token in ${PRACTICES_GH_TOKEN_FILE:-$HOME/.config/biffo/gh-token}" >&2
  echo "practices-daily:   install -d -m 700 ~/.config/biffo && umask 077 && gh auth token > ~/.config/biffo/gh-token" >&2
  exit 1
fi
echo "practices-daily: authenticated to GitHub as $_whoami"

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

# The three estate audits (#867).
#
# All three exit non-zero on a real problem and, until now, all three were run
# by hand. That is exactly how the gate blind spot survived: `verify passed` on
# eight repos that checked nothing they were written in, for as long as nobody
# thought to look. A check nobody runs is indistinguishable from one that does
# not exist -- the same finding this scoreboard already records about the
# orphan-worktree rule.
#
#   gate-coverage  does each repo's gate mirror THAT repo's CI?   <- the headline
#   hook-audit     will the hook actually fire?                   <- prerequisite
#   shared-sync    is every repo on the current shared files?     <- prerequisite
#
# `set -e` is live here, so each is guarded and its exit code captured rather
# than allowed to kill the run. A failing audit must REPORT, not abort: the
# whole point is a number on the page every morning, and a cron job that dies on
# the first red would take the dashboard down with it -- fail-open's mirror
# image, and just as useless.
ESTATE="${PRACTICES_ESTATE:-$HOME/code}"
AUDITS="$DATA_DIR/estate-audits.json"

audit_json() {
  _name="$1"; _cmd="$2"
  # `cmd; rc=$?` does NOT survive `set -e` -- the assignment carries the failing
  # status and the script dies before the next line. Verified: the guarded form
  # is the only one that reaches the report. Getting this wrong would have taken
  # the dashboard down on the first red audit, which is fail-open's mirror image
  # and just as useless: the morning a gate breaks is the morning the page that
  # would tell you goes missing.
  _out=$(sh -c "$_cmd" 2>&1) && _rc=0 || _rc=$?
  # Strip ANSI: this lands in JSON and on a web page, and escape codes there are
  # noise that hides the number.
  _clean=$(printf '%s' "$_out" | sed 's/\x1b\[[0-9;]*m//g')
  _summary=$(printf '%s' "$_clean" | grep -E "$3" | tail -1 | sed 's/^ *//;s/ *$//')
  node -e '
    const [name, rc, summary] = process.argv.slice(1)
    process.stdout.write(JSON.stringify({ name, ok: rc === "0", exit: Number(rc), summary }))
  ' "$_name" "$_rc" "${_summary:-no summary line}"
}

{
  printf '{"collectedAt":"%s","audits":[' "$(date -u +%FT%TZ)"
  audit_json coverage "sh scripts/gate-coverage.sh --estate '$ESTATE'" 'covers its own CI|do not cover'
  printf ','
  # Anchored: hook-audit prints both "N working trees - ..." and a "DEAD working
  # trees:" header, and an unanchored match took the header, so a failing audit
  # reported a heading instead of the count.
  audit_json arming "sh scripts/hook-audit.sh --estate '$ESTATE'" '^[0-9]+ working trees'
  printf ','
  audit_json drift "sh scripts/shared-sync.sh --check --estate '$ESTATE'" 'current, .* drifted'
  printf ','
  # Fourth audit (#715). Branch protection drifted for ~3 weeks across three
  # repos -- including the live core platform -- because a scaffold-time 403 is
  # skipped permanently and nothing ever re-asks. This is the re-asking.
  audit_json protection "sh scripts/protection-audit.sh --estate '$ESTATE'" 'branches checked'
  printf ','
  # Fifth audit (#884). `drift` above answers "did the file land"; this answers
  # "does anything call it". They went to zero and 7-of-13 respectively on the
  # same morning: eleven repos merged the shared audit scripts and every one
  # carried on running the raw command, so the distribution was complete and
  # the outcome had not moved. A proxy reported as the outcome, again.
  audit_json wiring "sh scripts/ci-wiring-audit.sh --estate '$ESTATE'" 'calls the shared scripts|still run the raw command'
  printf ']}\n'
} > "$AUDITS"

echo "practices-daily: estate audits ->"
node -e '
  const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  for (const r of a.audits) console.log(`  ${r.ok ? "OK  " : "FAIL"} ${r.name.padEnd(9)} ${r.summary}`)
' "$AUDITS"

node scripts/practices-dashboard.mjs --out "$PAGE" --data "$DATA_DIR"

# A stable path outside the worktree, so the page can be bookmarked once and
# stay correct. The copy inside the worktree moves with every rebase and gets
# rewritten by the next run; a bookmark pointing at it would break silently the
# first time the branch was recreated.
STABLE="${PRACTICES_PAGE:-$HOME/practices-dashboard.html}"
cp "$PAGE" "$STABLE"
echo "practices-daily: page at file://$STABLE"

# A failing audit is a nudge, not a silent row in a JSON file. Same channel the
# stale-effort-log nudge already uses.
FAILING=$(node -e '
  const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  const bad = a.audits.filter((r) => !r.ok)
  if (bad.length) process.stdout.write(bad.map((r) => `${r.name}: ${r.summary}`).join(" | "))
' "$AUDITS")
if [ -n "$FAILING" ]; then
  echo "practices-daily: ESTATE AUDIT FAILING - $FAILING" >&2
  if command -v notify-send >/dev/null 2>&1 && [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    notify-send -u critical "Estate audit failing" "$FAILING" >/dev/null 2>&1 || true
  fi
fi

# Copy the two external logs onto the snapshot branch BEFORE the commit (#940).
#
# This used to happen ~50 lines below, i.e. AFTER the commit and push — and the
# comment there claimed it was "what version-controls the history". It was not:
# every run starts with `git reset --hard`, so the copy was discarded before the
# next commit could ever see it. `docs/practices/sessions.jsonl` had therefore
# NEVER been committed; the live log had 61 rows and `dev` had no such file.
#
# It was masked by the `git add ... 2>/dev/null || git add "$DATA_DIR" "$PAGE"`
# fallback that used to be on the line below: `git add` fails on a path that does
# not exist, the fallback quietly staged the other two, and the run reported
# success. A fallback that hides a missing file is how a persistence step gets to
# do nothing for weeks.
#
# Both logs live outside the repo so appending never dirties a working checkout and
# no PR is needed per entry. `|| true` on each: a bare `[ -f x ] && cp` is a
# compound whose status is the test's, so on a machine with neither log yet the
# line would abort the script under `set -e`.
EFFORT="${PRACTICES_EFFORT_LOG:-$HOME/.practices-sessions.jsonl}"
STANDUP="${PRACTICES_STANDUP_LOG:-$HOME/.practices-standup.jsonl}"
TRACKED_LOGS="docs/practices/sessions.jsonl docs/practices/standup.jsonl"
{ [ -f "$EFFORT" ] && cp "$EFFORT" docs/practices/sessions.jsonl; } || true
{ [ -f "$STANDUP" ] && cp "$STANDUP" docs/practices/standup.jsonl; } || true

if git diff --quiet -- "$DATA_DIR" "$PAGE" $TRACKED_LOGS; then
  echo "practices-daily: no change"
  exit 0
fi

# No `|| git add "$DATA_DIR" "$PAGE"` fallback: that is what hid the bug above. A
# log that does not exist yet is simply not staged, and `git add` tolerates that
# when the other paths are valid — but a genuine failure now surfaces.
git add "$DATA_DIR" "$PAGE" $TRACKED_LOGS
# --no-verify: this is a generated artefact on a data branch, and the pre-push
# whole-project pyright is irrelevant to it. Every other gate still applies when
# the branch is reviewed.
git -c commit.gpgsign=false commit --no-verify -q -m "chore(practices): snapshot $(date -u +%F)"
# --force-with-lease because the reset above rewrites this branch every run.
# `--force-with-lease` rather than `--force`: if someone else has pushed to the
# branch, fail loudly instead of discarding their commit silently.
#
# --no-verify matches the commit above, and for the same reason -- but it became
# REQUIRED rather than merely consistent on 2026-07-29, and the way it broke is
# the point.
#
# Arming the git hooks across the estate that day moved them from husky's
# `core.hooksPath = .husky/_` to the shared `.git/hooks`, which every linked
# worktree inherits. This worktree is long-lived, created by cron, and never
# receives `pnpm install` -- so the newly-live pre-push gate ran `turbo`,
# `prettier` and `pyright` against a missing `node_modules`, failed six checks,
# and git rejected the push. Under `set -e` that killed the job at its last step:
# every audit had run, the dashboard had rendered, and the snapshot reached
# nothing.
#
# So the job that MEASURES whether hooks are armed was silently broken by arming
# them, and would have reported no snapshot every morning until someone noticed
# the series had stopped. The gate was not wrong -- it is irrelevant here: this
# branch carries generated JSON and HTML, is deliberately never auto-merged, and
# is reviewed as a whole when it is merged by hand.
#
# The exit status is still checked (`set -e` is live and this is not piped), so
# a genuine push failure -- a lease violation, no network, bad credentials --
# still fails the job loudly. --no-verify skips the local gate, not the result.
git push origin "$BRANCH" --force-with-lease --no-verify --quiet
echo "practices-daily: pushed snapshot $(date -u +%F)"

# Nudge, if the ground truth is going stale. Every headline figure on the page is
# inferred from commit types and repo names; a session log is the only thing that
# can falsify that inference, and it is the one part nobody can automate. A rule
# with nothing watching it stops being followed silently — that is how nine
# orphan worktrees accumulated under a documented hygiene rule.
# The copies now happen before the commit (see #940 above). $EFFORT is already set
# there; only the nudge remains here, which reads the external log directly.
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
