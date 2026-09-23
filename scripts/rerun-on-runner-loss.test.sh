#!/usr/bin/env sh
#
# Self-test for scripts/rerun-on-runner-loss.sh (#1997).
#
# The script decides whether a failed workflow run was killed by a reclaimed
# spot runner or by a genuine defect, and re-runs it only in the first case.
# Both directions of that decision are load-bearing, and they fail differently:
#
#   - Missing a runner loss leaves a PR red for nothing. That is the status quo
#     this exists to remove, and it is merely wasteful.
#   - Mistaking a REAL failure for a runner loss re-runs a broken change until
#     something gives up. That is worse, because it manufactures the appearance
#     of flakiness on a deterministic bug and hides it.
#
# So the must-not-catch cases below matter at least as much as the must-catch
# one, and both are asserted against the real script rather than a paraphrase.
#
# Every case stubs `gh` on PATH: the script's whole contract with the outside
# world is four `gh` calls, so stubbing that boundary exercises the actual
# decision logic with no network, no repo, and no Actions run.
#
# Runs every case under BOTH bash and dash where dash exists, because this is a
# runtime option-parse-adjacent script and `-n` cannot catch a dash/bash
# divergence in `cut`, `grep -qF` or the `for` loop -- the lesson
# scripts/interpreter-audit.sh exists to enforce one level up. A MISSING dash is
# reported as its own distinct outcome (exit 2, "could not run"), never folded
# into a pass or a failure: the self-hosted Amazon Linux 2023 fleet has no dash
# package at all, and #1652 records a self-test that read that absence as a
# caught regression.
#
# POSIX sh; validate with BOTH `dash -n` and `bash -n`.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$ROOT/scripts/rerun-on-runner-loss.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

echo "self-test: re-run only when the runner died (#1997)"

mkdir -p "$TMP/bin"

# The stub answers each of the script's four calls from a file, so a case is
# defined entirely by what it drops in $TMP. `gh run rerun` records that it was
# called -- the single most important observation in this file, because every
# must-not-catch case asserts that this file does NOT appear.
cat > "$TMP/bin/gh" <<'STUB'
#!/bin/sh
case "$1" in
  api)
    case "$2" in
      *"/jobs"*)        cat "$STUBDIR/jobs" 2>/dev/null || { echo "$GH_ERR" >&2; exit 1; } ;;
      *"/annotations"*)
        # Count reads so a case can assert a failed read is not retried (#2099).
        printf 'x\n' >> "$STUBDIR/ann-calls"
        cat "$STUBDIR/annotations" 2>/dev/null || { echo "$GH_ERR" >&2; exit 1; } ;;
      *"/actions/runs/"*) cat "$STUBDIR/run" 2>/dev/null || { echo "$GH_ERR" >&2; exit 1; } ;;
      *) echo "$GH_ERR" >&2; exit 1 ;;
    esac ;;
  run)
    # "$2" is the subcommand -- rerun. Record the call, then honour the case's
    # scripted exit so the API-refused path is reachable.
    printf 'rerun called\n' >> "$STUBDIR/rerun-calls"
    exit "$(cat "$STUBDIR/rerun-exit" 2>/dev/null || echo 0)" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/gh"

ANN_LOST='The self-hosted runner lost communication with the server. Verify the machine is running and has a healthy network connection.'
ANN_REAL='Process completed with exit code 1.
FAILED services/api/tests/test_thing.py::test_a_real_defect'

# The real error `gh api` prints when the token lacks a scope (#2099). The stub
# writes it to stderr on every failed read, exactly where the real gh does.
GH_ERR='gh: Resource not accessible by integration (HTTP 403)'

# run_case <case-dir> <shell> -> sets CASE_RC and CASE_OUT
run_case() {
  _dir=$1; _shell=$2
  set +e
  CASE_OUT=$(STUBDIR="$_dir" GH_ERR="$GH_ERR" PATH="$TMP/bin:$PATH" GITHUB_REPOSITORY=o/r \
               "$_shell" "$SCRIPT" 99 2>&1)
  CASE_RC=$?
  set -e
}

# A case is prepared once and then run under each shell in turn, asserting the
# SAME outcome from both -- a divergence here is a real defect, not a detail.
SHELLS="sh"
if command -v bash >/dev/null 2>&1; then SHELLS="$SHELLS bash"; fi
HAVE_DASH=0
if command -v dash >/dev/null 2>&1 && dash -c 'exit 0' >/dev/null 2>&1; then
  SHELLS="$SHELLS dash"; HAVE_DASH=1
fi

# assert_case <name> <dir> <want-rerun:yes|no> <want-rc> <expect-substring>
assert_case() {
  _name=$1; _dir=$2; _want=$3; _rc=$4; _needle=$5
  for _sh in $SHELLS; do
    rm -f "$_dir/rerun-calls" "$_dir/ann-calls"
    run_case "$_dir" "$_sh"
    if [ "$CASE_RC" != "$_rc" ]; then
      bad "$_name [$_sh]" "expected exit $_rc, got $CASE_RC — $CASE_OUT"
      return
    fi
    case "$CASE_OUT" in
      *"$_needle"*) : ;;
      *) bad "$_name [$_sh]" "expected output containing [$_needle], got [$CASE_OUT]"; return ;;
    esac
    if [ "$_want" = yes ] && [ ! -f "$_dir/rerun-calls" ]; then
      bad "$_name [$_sh]" "expected a re-run, none was triggered"; return
    fi
    if [ "$_want" = no ] && [ -f "$_dir/rerun-calls" ]; then
      bad "$_name [$_sh]" "a re-run was triggered and must not have been"; return
    fi
  done
  ok "$_name"
}

# ---------------------------------------------------------------------------
# MUST-CATCH: the reclaimed runner. This is the tabsii-platform#1420 shape --
# a failed run whose failed job carries the Actions service's own annotation.
# ---------------------------------------------------------------------------
C="$TMP/lost"; mkdir -p "$C"
printf '1\tfailure\n' > "$C/run"
printf '900001\n'      > "$C/jobs"
printf '%s\n' "$ANN_LOST" > "$C/annotations"
assert_case "a reclaimed runner is re-run once" "$C" yes 0 "re-ran the failed jobs"

# ---------------------------------------------------------------------------
# MUST-NOT-CATCH: a real test failure. The single most important assertion in
# this file -- re-running this one would manufacture flakiness on a real bug.
# ---------------------------------------------------------------------------
C="$TMP/real"; mkdir -p "$C"
printf '1\tfailure\n' > "$C/run"
printf '900001\n'      > "$C/jobs"
printf '%s\n' "$ANN_REAL" > "$C/annotations"
assert_case "a real test failure is left red" "$C" no 0 "must stay red"

# ---------------------------------------------------------------------------
# MUST-NOT-CATCH: a run that has already been re-run. This is BOTH the
# once-only rule and the recursion guard -- without it this workflow triggers
# itself for ever, since its own re-run produces another completed run.
# ---------------------------------------------------------------------------
C="$TMP/attempt2"; mkdir -p "$C"
printf '2\tfailure\n' > "$C/run"
printf '900001\n'      > "$C/jobs"
printf '%s\n' "$ANN_LOST" > "$C/annotations"
assert_case "an already-re-run run is declined even when the runner did die" "$C" no 0 "already re-run once"

# ---------------------------------------------------------------------------
# MUST-NOT-CATCH: a run that did not fail at all.
# ---------------------------------------------------------------------------
C="$TMP/success"; mkdir -p "$C"
printf '1\tsuccess\n' > "$C/run"
printf '900001\n'      > "$C/jobs"
printf '%s\n' "$ANN_LOST" > "$C/annotations"
assert_case "a run that did not fail is never re-run" "$C" no 0 "nothing to re-run"

# ---------------------------------------------------------------------------
# MIXED RUN: one job blames the runner, another failed for real. The whole run
# is re-run -- a pool-wide reclamation takes several jobs at once, and a
# genuinely-failing job swept along simply fails again in seconds.
# ---------------------------------------------------------------------------
C="$TMP/mixed"; mkdir -p "$C"
printf '1\tfailure\n'   > "$C/run"
printf '900001\n900002\n' > "$C/jobs"
# The stub serves the same annotations to every job; the real-failure text is
# present alongside the runner-loss text, which is what a mixed run looks like
# to the grep.
printf '%s\n%s\n' "$ANN_REAL" "$ANN_LOST" > "$C/annotations"
assert_case "a mixed run with one lost runner is re-run" "$C" yes 0 "reclaimed capacity"

# ---------------------------------------------------------------------------
# COULD-NOT-TELL IS LOUD. An unreadable run must fail the job, not quietly
# decline: a guard that cannot read its input and says nothing is decoration.
# ---------------------------------------------------------------------------
C="$TMP/unreadable"; mkdir -p "$C"   # no files at all: every gh api call exits 1
assert_case "an unreadable run fails loudly rather than silently declining" "$C" no 1 "cannot tell"

# ---------------------------------------------------------------------------
# COULD-NOT-TELL, second shape: the run reads, the job list does not.
# ---------------------------------------------------------------------------
C="$TMP/nojobs"; mkdir -p "$C"
printf '1\tfailure\n' > "$C/run"
assert_case "an unreadable job list fails loudly" "$C" no 1 "could not list failed jobs"

# ---------------------------------------------------------------------------
# THE CAUSE OF #2097, NOT ITS SYMPTOM (#2099). In a PRIVATE repo the workflow's
# `permissions:` block is the whole token: an explicit block sets every scope it
# does not list to `none`, and reading a check run's annotations needs
# `checks: read`. tabsii-platform failed 8 of 8 non-skipped runs for exactly
# this, ~1s in, and the log said only "could not read annotations" because the
# real 403 was thrown away. A public repo passes without the scope, so no run
# here can catch its absence -- the workflow file itself is what is asserted.
# ---------------------------------------------------------------------------
WORKFLOW="$ROOT/.github/workflows/rerun-on-runner-loss.yml"
if awk '/^permissions:/{f=1;next} f&&/^[^ #]/{exit} f' "$WORKFLOW" | grep -qx '  checks: read'; then
  ok "the workflow grants checks: read (annotations are unreadable in a private repo without it)"
else
  bad "the workflow grants checks: read" "top-level permissions: in $WORKFLOW lacks 'checks: read' — the annotation read 403s in every private repo (#2099)"
fi

# The real HTTP error must reach the log, from each of the three reads. With
# stderr discarded (`2>/dev/null`) the only output is "could not read ...", which
# cannot tell a missing scope (403) from a missing run (404) from a rate limit.
C="$TMP/err-run"; mkdir -p "$C"   # run read fails
assert_case "a failed run read surfaces gh's own error" "$C" no 1 "HTTP 403"

C="$TMP/err-jobs"; mkdir -p "$C"
printf '1\tfailure\n' > "$C/run"
assert_case "a failed job-list read surfaces gh's own error" "$C" no 1 "HTTP 403"

C="$TMP/err-ann"; mkdir -p "$C"
printf '1\tfailure\n' > "$C/run"
printf '900001\n'      > "$C/jobs"
assert_case "a failed annotation read surfaces gh's own error" "$C" no 1 "HTTP 403"

# A deterministic failure must not be retried: the 403 above is the same on the
# second read and the hundredth, so every retry is only delay before the same
# loud failure. Exactly one read.
rm -f "$C/ann-calls"; run_case "$C" sh
_reads=$(wc -l < "$C/ann-calls" | tr -d ' ')
if [ "$_reads" = 1 ]; then
  ok "a failed annotation read is attempted once, not retried"
else
  bad "a failed annotation read is attempted once, not retried" "annotation endpoint was read $_reads times"
fi

# ---------------------------------------------------------------------------
# A REFUSED RE-RUN IS ITS OWN OUTCOME, distinct from "declined". Exercises the
# exit-code path too: `gh run rerun` prints NOTHING on success when stdout is
# not a terminal, so this script must judge it by exit code alone
# (biffo-fleet#77 is that exact mistake, made and filed).
# ---------------------------------------------------------------------------
C="$TMP/refused"; mkdir -p "$C"
printf '1\tfailure\n' > "$C/run"
printf '900001\n'      > "$C/jobs"
printf '%s\n' "$ANN_LOST" > "$C/annotations"
printf '1\n'           > "$C/rerun-exit"
assert_case "a refused re-run reports its own exit code" "$C" yes 2 "was refused"

if [ "$HAVE_DASH" -eq 0 ]; then
  printf '\n  NOTE: dash is not installed here, so no case was checked under it.\n'
  printf '        That is "could not run", NOT a pass — see #1652.\n'
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
