#!/usr/bin/env sh
#
# `biffo doctor --fix` across every repo under an estate directory (#1682
# milestone 3 — the periodic-sweep half; `biffo-workflow` Step 7 is the other
# caller). Same shape as `shared-sync.sh --estate` for the same reason: the
# repos are all already on disk, so walking them costs seconds and needs no
# GitHub calls to enumerate.
#
# `biffo-workflow` Step 7 already runs `doctor --fix` at the end of every
# ordinary unit of work, and `--fix` always reaps every eligible worktree/
# branch in a repo, not only the one that session just touched — so ordinary
# work already keeps a repo mostly current. This sweep exists for what Step 7
# structurally cannot reach: a session that stopped before Step 7 (crashed,
# was a delegate that only ever opens a PR and reports back per AGENTS.md §4),
# or a repo nobody has done a unit of work in for a while. Measured 2026-08-31:
# biffo-template alone carried 53GB across 53 already-merged, never-reaped
# worktrees — accumulated over about three weeks with Step 7 doing nothing to
# stop it, because most of the sessions that opened those PRs never ran Step 7
# at all.
#
#   sh scripts/doctor-sweep.sh --estate ~/code
#
# Every repo is swept independently; one repo's failure does not stop the
# others — same "a network blip must not stop the fleet" posture
# `fleet-cron.sh` already uses, applied here to a single bad checkout instead
# of a single bad network call.
set -eu

ESTATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --estate) ESTATE="$2"; shift 2 ;;
    *) echo "doctor-sweep: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
[ -n "$ESTATE" ] || { echo "--estate <dir> is required" >&2; exit 2; }
[ -d "$ESTATE" ] || { echo "doctor-sweep: $ESTATE is not a directory" >&2; exit 2; }

swept=0
failed=0
skipped=0

for d in "$ESTATE"/*/; do
  d="${d%/}"
  [ -e "$d/.git" ] || continue
  # Only a repo carrying scripts/biffo.sh can resolve a doctor invocation at
  # all (template, instance, or a satellite `shared-sync.sh` has already
  # stamped) — anything else has no CLI to run and is silently out of scope,
  # not a failure.
  if [ ! -f "$d/scripts/biffo.sh" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  name=$(basename "$d")
  printf '\n=== %s ===\n' "$name"
  if (cd "$d" && sh scripts/biffo.sh doctor --fix); then
    swept=$((swept + 1))
  else
    # doctor exits non-zero on any ERROR-severity finding (stale checkout,
    # etc.) even when --fix itself ran fine — that is doctor's own contract,
    # not this sweep's failure to report. Count it, keep going.
    printf '%s: doctor reported findings or could not run cleanly\n' "$name" >&2
    failed=$((failed + 1))
  fi
done

printf '\ndoctor-sweep: %s repo(s) swept, %s reported findings, %s skipped (no scripts/biffo.sh) under %s\n' \
  "$swept" "$failed" "$skipped" "$ESTATE"
