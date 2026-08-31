#!/usr/bin/env bash
#
# One `biffo doctor --fix` sweep of the estate per day (#1682 milestone 3).
#
# Same shape as `shared-sync-daily.sh`, for the same reason: nothing was
# scheduling this before it existed, and a mechanism only an interactive
# session remembers to run is the exact failure this file exists to remove.
# `biffo-workflow` Step 7 is the OTHER caller — this is the backstop for
# whatever Step 7 never reaches (a session that stopped before Step 7, or a
# repo nobody has touched in a while). See scripts/doctor-sweep.sh's own doc
# comment for the measurement that motivated this (53GB, one repo, ~3 weeks).
#
# Install (daily at 05:00 — after shared-sync-daily's 04:00 round and before
# the practices collection some installs run at 04:30/05:xx, so a stale
# checkout from an in-flight shared-sync round is never what this sweeps):
#   crontab -e
#   0 5 * * * /home/keiran/code/biffo-template/scripts/doctor-sweep-daily.sh >> /home/keiran/.doctor-sweep-daily.log 2>&1
#
# That redirect is a harmless duplicate, not the log's only source — the
# script writes ${DOCTOR_SWEEP_LOG:-~/.doctor-sweep-daily.log} itself, same
# "every invocation path is recorded, not only cron's" reasoning
# shared-sync-daily.sh already states at length (#1126).

set -euo pipefail

DOCTOR_SWEEP_LOG="${DOCTOR_SWEEP_LOG:-$HOME/.doctor-sweep-daily.log}"
exec > >(tee -a "$DOCTOR_SWEEP_LOG") 2>&1

REPO_ROOT="${DOCTOR_SWEEP_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
ESTATE="${DOCTOR_SWEEP_ESTATE:-$HOME/code}"

_invocation_source() {
  if [ -r "/proc/$PPID/comm" ] && grep -qi '^cron' "/proc/$PPID/comm" 2>/dev/null; then
    echo "cron"
  elif [ -t 0 ] || [ -t 1 ]; then
    echo "interactive"
  else
    echo "non-interactive"
  fi
}

echo "doctor-sweep-daily: START $(date -u +%FT%TZ) via $(_invocation_source) (pid $$ ppid $PPID)"

_finish() {
  _rc=$?
  if [ "$_rc" -eq 0 ]; then
    echo "doctor-sweep-daily: DONE $(date -u +%FT%TZ)"
  else
    echo "doctor-sweep-daily: ABORTED rc=$_rc $(date -u +%FT%TZ)" >&2
  fi
}
trap _finish EXIT

cd "$REPO_ROOT"

# The sweep script itself must be current, same reasoning shared-sync-daily.sh
# gives for pulling before running: a stale template checkout would run
# yesterday's classification logic against today's estate.
echo "doctor-sweep-daily: bringing $REPO_ROOT to origin/dev"
git fetch --quiet origin dev
git pull --ff-only --quiet origin dev

sh scripts/doctor-sweep.sh --estate "$ESTATE"
