#!/usr/bin/env bash
#
# One shared-file distribution round per day.
#
# Why this exists.
#
# Nothing scheduled `shared-sync.sh` — verified 2026-08-04, no workflow in any
# repo referenced it. It was run by hand, reactively, after template merges. On
# 2026-08-03 that meant 19 commits touching shared files (05:24–22:13) produced
# ~6.8 rounds across 12 repos: **81 merges, 69 of them avoidable** — and that 69
# was *the estate's entire avoidable-merge count for the day*
# (`windows.1.amplification`, whose `top` list has exactly one entry).
#
# A settle window cannot fix that, and it was the first thing tried on paper: the
# changes are spread across seventeen hours and were already being hand-batched
# at ~2.7 changes per round, so debouncing bursts leaves ~7 rounds standing. Only
# collapsing to a fixed round changes the number — 7 rounds to 1 takes 81 merges
# to ~12.
#
# Install (daily at 04:00, before the practices collection at 04:30 so the day's
# snapshot sees a settled estate):
#   crontab -e
#   0 4 * * * /home/keiran/code/biffo-template/scripts/shared-sync-daily.sh >> /home/keiran/.shared-sync-daily.log 2>&1
#
# That redirect is a harmless duplicate, not the log's only source — the script
# writes ${SHARED_SYNC_LOG:-~/.shared-sync-daily.log} itself, so every invocation
# path is recorded rather than only cron's. `practices-daily.sh` records at
# length why that matters (#1126): a log whose only writer is the crontab
# silently carries an invocation-path filter, and every reader treats it as
# complete.
#
# The trade this makes, stated rather than buried: worst-case distribution
# latency becomes 24 hours. `shared-sync.sh --now` is the escape hatch for a
# governance change that must not wait. Note the arrangement it replaces was
# *worse* on latency, not better — the claim-collision pre-push gate landed at
# 21:35 on 2026-08-03 and was still in zero satellites eight hours later,
# because reactive distribution depends on somebody remembering.

set -euo pipefail

SHARED_SYNC_LOG="${SHARED_SYNC_LOG:-$HOME/.shared-sync-daily.log}"
exec > >(tee -a "$SHARED_SYNC_LOG") 2>&1

REPO_ROOT="${SHARED_SYNC_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
ESTATE="${SHARED_SYNC_ESTATE:-$HOME/code}"

# The marker `shared-sync.sh` reads to decide whether a scheduled round actually
# exists. Two properties, both load-bearing:
#
#  - written by the RUN rather than by the install, because an
#    installed-but-broken cron entry would otherwise gate every ad-hoc round
#    behind --now while distributing nothing — strictly worse than no schedule;
#  - keyed to the ESTATE rather than $HOME, because the question is "has a round
#    run for this estate". A $HOME-global path made seven fixture tests read the
#    developer's own marker and fail on this workstation while CI, which has no
#    marker, stayed green.
#
# See `_scheduled_round_is_live` for the other half of this contract.
MARKER="${SHARED_SYNC_MARKER:-$ESTATE/.shared-sync-daily.last}"

_invocation_source() {
  if [ -r "/proc/$PPID/comm" ] && grep -qi '^cron' "/proc/$PPID/comm" 2>/dev/null; then
    echo "cron"
  elif [ -t 0 ] || [ -t 1 ]; then
    echo "interactive"
  else
    echo "non-interactive"
  fi
}

echo "shared-sync-daily: START $(date -u +%FT%TZ) via $(_invocation_source) (pid $$ ppid $PPID)"

_finish() {
  _rc=$?
  if [ "$_rc" -eq 0 ]; then
    echo "shared-sync-daily: DONE $(date -u +%FT%TZ)"
  else
    echo "shared-sync-daily: ABORTED rc=$_rc $(date -u +%FT%TZ)" >&2
  fi
}
trap _finish EXIT

cd "$REPO_ROOT"

# The round must ship what THIS tree holds, so a stale template checkout would
# distribute yesterday's files estate-wide. `shared-sync.sh` refuses outright
# when the checkout is behind; pulling first means the scheduled round does not
# simply fail every morning the primary drifts.
echo "shared-sync-daily: bringing $REPO_ROOT to origin/dev"
git fetch --quiet origin dev
git pull --ff-only --quiet origin dev

# `--scheduled` is what distinguishes this from an ad-hoc round; it is the one
# caller allowed through the gate without --now.
sh scripts/shared-sync.sh --scheduled --estate "$ESTATE"

# Written only on success, and only here. A failed round leaves the previous
# marker in place and therefore ages out on its own after 48 hours, at which
# point ad-hoc rounds stop being gated — the schedule proving itself dead is
# exactly when the manual path must reopen.
date -u +%FT%TZ > "$MARKER"
echo "shared-sync-daily: round complete, marker at $MARKER"
