#!/usr/bin/env sh
#
# Self-test for the CALLER-DEADLINE bound in scripts/wait-for-checks.sh.
#
# A wait that outlives its caller is worse than no wait. This script's own
# timeout said how long IT would wait and nothing about how long its caller had
# left, and that gap lost whole sessions.
#
# Measured 2026-08-22, biffo-fleet Foreman `7d362ba7`, running under
# `timeout 3300`: it pushed a commit at 05:37:03 and started wait-for-checks at
# 05:37:04 with ~5 minutes of its 55-minute budget left. CI was genuinely in
# flight and would have concluded at 05:48:18 — a correct ~11 minute wait. The
# session was SIGKILLed at 05:42:45, the script returned 137, and the turn was
# lost mid-flight with no verdict and no cost record (`cost=UNKNOWN`). The
# eleventh such kill in three days.
#
# Nothing was wrong with the checks or with the waiting, which is why this is
# tested behaviourally rather than by grepping for the new variable: the
# property is "it stops in time", not "the code mentions a deadline".
#
# Four properties, and the last two are the controls that stop this passing
# against a script that simply refuses to wait for anything:
#
#   1. no time left        -> exit 2 BEFORE any API call
#   2. deadline mid-wait   -> exit 2 naming the CALLER, not CI
#   3. non-numeric bound   -> IGNORED, never read as zero
#   4. bound unset         -> byte-identical behaviour to before
#
# POSIX sh; validate with BOTH `dash -n` and `bash -n`.
set -u

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
WFC="$HERE/wait-for-checks.sh"
# RUN UNDER bash, never `sh`. wait-for-checks.sh declares `#!/usr/bin/env bash` and
# uses `set -o pipefail`, which dash does not implement.
#
# The first cut ran it under `sh` and PASSED LOCALLY, because this workstation's dash
# is new enough to support pipefail; the CI runner's is not, and five of eight cases
# failed there with "Illegal option -o pipefail". Executing the file directly to
# honour its shebang would be tidier and would keep one document instead of two, but
# it is mode 100644 in git and that gives exit 126 -- so the interpreter is named
# here, exactly as cli/src/lib/wait-for-checks.test.ts already names it.
CASES_RUN=0
FAILURES=0

ok()  { CASES_RUN=$((CASES_RUN + 1)); printf '  ok   %s\n' "$1"; }
bad() { CASES_RUN=$((CASES_RUN + 1)); FAILURES=$((FAILURES + 1)); printf '  FAIL %s\n     %s\n' "$1" "$2"; }

[ -r "$WFC" ] || { echo "wait-for-checks-deadline.test.sh: cannot read $WFC" >&2; exit 2; }

TMP=$(mktemp -d) || exit 2
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# A `gh` that never concludes: the checks stay PENDING forever, so anything that
# returns did so because of a deadline and not because CI finished. `protection`
# returns nothing, which puts the script in its stability fallback.
cat > "$TMP/bin/gh" <<'GHEOF'
#!/bin/sh
echo "$*" >> "$GH_LOG"
for a in "$@"; do
  case "$a" in
    state,baseRefName) printf '%s\tdev\n' "${STUB_STATE:-OPEN}"; exit 0 ;;
    mergeable)         echo "MERGEABLE"; exit 0 ;;
    statusCheckRollup) echo "CI	PENDING	1"; exit 0 ;;
  esac
done
exit 0
GHEOF
chmod +x "$TMP/bin/gh"
GH_LOG="$TMP/gh.log"; export GH_LOG
PATH="$TMP/bin:$PATH"; export PATH

calls() { c=$(grep -c . "$GH_LOG" 2>/dev/null); echo "${c:-0}"; }

# --- 1. No time left: exit 2, and NOT ONE API CALL --------------------------------
# Being killed mid-wait costs the caller its whole turn; exiting now leaves it
# time to record what it already knows. The zero-call assertion is the point --
# a version that exits 2 only after three API calls can still be killed during
# them, which is the failure being fixed.
: > "$GH_LOG"
# Bounded for the same reason as case 2: WITHOUT the fix this case does not exit
# at all -- it falls through to the default 1800s wait, so an unguarded assertion
# hangs CI rather than failing it.
out=$(WAIT_FOR_CHECKS_DEADLINE=$(date +%s) timeout 20 bash "$WFC" 1 -R a/b 2>&1); rc=$?
# The property is that it never POLLS, not that it makes no call at all: the
# cheap state read has to happen first so an already-merged PR still gets the
# exit 0 it has earned (see the MERGED case below, which this got wrong once).
polls=$(grep -c statusCheckRollup "$GH_LOG" 2>/dev/null); polls=${polls:-0}
if [ "$rc" -eq 124 ]; then
  bad "no time left: refuses before polling" \
      "did not exit at all — it started a wait it cannot finish"
elif [ "$rc" -eq 2 ] && [ "$polls" -eq 0 ]; then
  ok "no time left: refuses before polling"
else
  bad "no time left: refuses before polling" "exit=$rc polls=$polls (wanted 2 and 0)"
fi
case "$out" in
  *"not enough time left"*) ok "no time left: the message names the cause" ;;
  *) bad "no time left: the message names the cause" "said: $(printf '%s' "$out" | head -1)" ;;
esac

# --- 2. Deadline arriving MID-WAIT ------------------------------------------------
# The checks never conclude, so returning at all proves the bound fired. It must
# blame the CALLER, not CI: "the caller ran out" sends you to its budget, "we ran
# out" sends you to CI. Same exit code, different fix.
: > "$GH_LOG"
start=$(date +%s)
# `timeout 45` is the regression's OWN failure mode made fast. Without the bound
# this case runs the full 600s and CI hangs instead of failing -- measured when
# the fix was reverted to prove these assertions catch its absence. A guard that
# hangs on regression is not a guard.
out=$(WAIT_FOR_CHECKS_DEADLINE=$(( $(date +%s) + 64 )) WAIT_FOR_CHECKS_INTERVAL=1 \
      WAIT_FOR_CHECKS_TIMEOUT=600 timeout 45 bash "$WFC" 1 -R a/b 2>&1); rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$rc" -eq 124 ]; then
  bad "deadline mid-wait: stops early rather than running to its own timeout" \
      "ran past 45s — the caller bound is not being honoured at all"
elif [ "$rc" -eq 2 ] && [ "$elapsed" -lt 30 ]; then
  ok "deadline mid-wait: stops early rather than running to its own timeout"
else
  bad "deadline mid-wait: stops early rather than running to its own timeout" \
      "exit=$rc after ${elapsed}s (own timeout was 600s)"
fi
case "$out" in
  *"caller's deadline"*) ok "deadline mid-wait: blames the caller, not CI" ;;
  *) bad "deadline mid-wait: blames the caller, not CI" "said: $(printf '%s' "$out" | tail -3 | head -1)" ;;
esac

# --- 3. CONTROL: a non-numeric bound must be IGNORED ------------------------------
# An unreadable value read as zero would turn a caller's typo into a script that
# refuses to wait for anything -- a fail-fast bug of exactly the shape this
# script exists to prevent.
: > "$GH_LOG"
WAIT_FOR_CHECKS_DEADLINE="not-a-number" WAIT_FOR_CHECKS_INTERVAL=1 \
  WAIT_FOR_CHECKS_TIMEOUT=3 bash "$WFC" 1 -R a/b >/dev/null 2>&1
n=$(calls)
if [ "$n" -gt 0 ]; then
  ok "control: a non-numeric bound is ignored, not read as zero"
else
  bad "control: a non-numeric bound is ignored, not read as zero" "made no API call — it refused to wait"
fi

# --- 4. CONTROL: unset changes nothing --------------------------------------------
# Without this the three assertions above are satisfied by a script that has
# stopped waiting under every condition.
: > "$GH_LOG"
WAIT_FOR_CHECKS_INTERVAL=1 WAIT_FOR_CHECKS_TIMEOUT=3 bash "$WFC" 1 -R a/b >/dev/null 2>&1
n=$(calls)
if [ "$n" -gt 0 ]; then
  ok "control: with no bound set, it waits exactly as before"
else
  bad "control: with no bound set, it waits exactly as before" "made no API call"
fi

# --- CONTROL: a short OWN timeout is not a short caller life --------------------
# `--timeout 0` is a deliberate, tested "one pass then report". Keyed on the
# effective deadline alone rather than on whether a caller bound is in force, this
# refused to run at all -- caught by cli/src/lib/wait-for-checks.test.ts, not by
# the first version of this file, which is why it is now asserted here too.
: > "$GH_LOG"
out=$(timeout 20 bash "$WFC" 1 -R a/b --timeout 0 --interval 0 2>&1); rc=$?
case "$out" in
  *"not enough time left"*)
    bad "control: a short own timeout is not a short caller life" \
        "refused to run on --timeout 0 with no caller bound set" ;;
  *) ok "control: a short own timeout is not a short caller life" ;;
esac

# --- An already-merged PR needs no time, so there is nothing to refuse ----------
# Placed before the MERGED fast path, the bound turned an exit 0 it had already
# earned into "cannot tell".
: > "$GH_LOG"
out=$(STUB_STATE=MERGED WAIT_FOR_CHECKS_DEADLINE=$(date +%s) timeout 20 bash "$WFC" 1 -R a/b 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then
  ok "an already-merged PR still exits 0 even with no time left"
else
  bad "an already-merged PR still exits 0 even with no time left" \
      "exit=$rc — refused to answer a question that needed no waiting"
fi

# The denominator, printed unconditionally (#1413): a guard about a check that
# never ran must not report a pass having run zero cases.
echo
printf 'wait-for-checks-deadline.test.sh: %s case(s) actually run\n' "$CASES_RUN"
if [ "$CASES_RUN" -eq 0 ]; then
  echo "wait-for-checks-deadline.test.sh: CANNOT VERIFY -- zero cases ran." >&2
  exit 2
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "wait-for-checks-deadline.test.sh: $FAILURES of $CASES_RUN case(s) failed."
  exit 1
fi
echo "wait-for-checks-deadline.test.sh: all $CASES_RUN case(s) passed."
exit 0
