#!/usr/bin/env sh
#
# Self-test for scripts/rerun-on-stuck-queue.sh (#2081).
#
# The script decides whether a workflow run has a job stuck `queued` past a
# threshold with no runner ever picking it up, and if so cancels the run,
# waits for the cancellation to land, then re-runs it once. Two directions
# are load-bearing, same shape as rerun-on-runner-loss.test.sh:
#
#   - Missing a genuinely stuck job leaves a PR red/stalled for nothing.
#     Wasteful, but recoverable by hand.
#   - Cancelling and re-running a run that was NOT actually stuck (too
#     young, wrong workflow, already re-run once) destroys in-progress work
#     for no reason. That is the direction that must never happen silently.
#
# ## Case table (must-catch / must-not-catch), against REAL tool behaviour
#
# `gh` is stubbed on PATH (no network, no real Actions run) -- but where the
# real script hands data to the REAL `jq` binary, this test lets the real
# `jq` run: the run-listing stub re-runs the exact `--jq` filter the script
# passed it against a raw `{"workflow_runs": [...]}` fixture shaped like the
# documented List-workflow-runs API, and the per-job age check is never
# mocked at all -- the script pipes the stub's raw jobs JSON straight into
# its own `jq -r "$JQ_MAX_QUEUED_AGE"`, for real, every case. That means this
# file can never drift from the script's actual filter logic the way a
# hand-curated "final answer" fixture could.
#
# | # | case                                             | must (not) catch |
# |---|---------------------------------------------------|-------------------|
# | 1 | job queued past threshold, watched workflow, attempt 1 | MUST catch  |
# | 2 | job queued, but younger than threshold             | must NOT catch    |
# | 3 | job queued past threshold, run_attempt == 2        | must NOT catch (once-only) |
# | 4 | job queued past threshold, unwatched workflow name | must NOT catch (filtered by the script's own jq, not the fixture) |
# | 5 | run has no queued job at all (in_progress instead) | must NOT catch    |
# | 6 | no active runs                                     | nothing to inspect |
# | 7 | run-listing API call fails                         | loud, exit 1      |
# | 8 | per-run jobs API call fails                        | loud, exit 1      |
# | 9 | cancel accepted, never confirms `completed`        | loud, exit 1      |
# |10 | cancel itself refused                              | exit 2, no rerun  |
# |11 | rerun itself refused (after confirmed cancel)      | exit 2            |
# |12 | two runs in one invocation: one stuck+acted, one undetermined | worst code (1) wins, but BOTH are still processed -- the regression test for the pipe/subshell bug this script's own header warns about |
# |13 | multi-word watched workflow name ("RLS Tests")     | MUST catch, name intact |
# |14 | completed-run history present (#2100)              | list is server-side status= filtered, no unfiltered call, count printed |
# |15 | run itself in status `queued`                      | MUST catch via the queued listing |
# |16 | cancel lands on the 10th status read (#2101)       | MUST still be re-run under the production poll bound |
# |17 | in_progress listing fails, queued read fine         | loud, exit 1, no action |
# |18 | run listing is not JSON                            | loud, exit 1, no action |
# |19 | run listing is JSON but not run objects            | loud, exit 1, no action |
# | 9 | (extended, #2101) never confirms                   | message names `gh run rerun N`, no false "next scheduled poll" promise |
#
# Runs every case under sh, bash and dash (where present) -- same convention
# as rerun-on-runner-loss.test.sh, and for the same reason: this is a
# runtime-option/subshell-adjacent script (`dash -n`/`bash -n` cannot catch a
# `cmd | while read` losing its variables under bash's default non-lastpipe
# behaviour, which is exactly the bug case 12 exists to catch). A MISSING
# dash is its own reported outcome, never folded into a pass.
#
# POSIX sh; validate with BOTH `dash -n` and `bash -n`.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$ROOT/scripts/rerun-on-stuck-queue.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

echo "self-test: cancel + re-run a run stuck queued past threshold (#2081)"

mkdir -p "$TMP/bin"

# now() in epoch seconds, then <seconds-ago> in UTC ISO8601 -- matches the
# `created_at` field shape the real Jobs API returns.
iso_ago() {
  date -u -d "@$(( $(date +%s) - $1 ))" +%Y-%m-%dT%H:%M:%SZ
}

# The stub. $STUBDIR carries the fixtures for one case; every observation the
# assertions care about (which run ids got cancelled/re-run) is recorded to
# a file under it.
cat > "$TMP/bin/gh" <<'STUB'
#!/bin/sh
case "$1" in
  api)
    shift
    url=""
    jqquery=""
    take_next=0
    for a in "$@"; do
      if [ "$take_next" = "1" ]; then jqquery=$a; take_next=0; continue; fi
      case "$a" in
        --jq) take_next=1 ;;
        repos/*) url=$a ;;
      esac
    done
    path=${url%%\?*}
    case "$path" in
      repos/o/r/actions/runs)
        # The run-listing call: re-run the SCRIPT'S OWN --jq filter against a
        # raw fixture, for real, rather than serving a pre-filtered answer.
        [ -f "$STUBDIR/runs.json" ] || exit 1
        # Model the real API: a `status=` query parameter filters SERVER-side.
        # A request without one walks the whole history -- the ~111-page,
        # ~4-minute cost of #2100 -- so it is recorded as an "unfiltered" call
        # (which the case-14 assertion refuses) and served the full fixture.
        query=""
        case "$url" in *\?*) query=${url#*\?} ;; esac
        st=""
        case "&$query&" in *"&status="*) st=${query#*status=}; st=${st%%&*} ;; esac
        # Fault injection for the script's could-not-tell paths.
        [ ! -f "$STUBDIR/fail-list-$st" ] || exit 1
        if [ -f "$STUBDIR/garbage-list" ]; then cat "$STUBDIR/garbage-list"; exit 0; fi
        if [ -z "$st" ]; then
          printf 'unfiltered\n' >> "$STUBDIR/unfiltered-list-call"
          jq -r "$jqquery" "$STUBDIR/runs.json" || exit 1
        else
          printf '%s\n' "$st" >> "$STUBDIR/list-calls"
          jq --arg s "$st" '{workflow_runs: [.workflow_runs[] | select(.status == $s)]}' \
            "$STUBDIR/runs.json" | jq -r "$jqquery" || exit 1
        fi
        ;;
      repos/o/r/actions/runs/*/jobs)
        rest=${path#repos/o/r/actions/runs/}
        runid=${rest%/jobs}
        cat "$STUBDIR/jobs-$runid" 2>/dev/null || exit 1
        ;;
      repos/o/r/actions/runs/*)
        runid=${path#repos/o/r/actions/runs/}
        [ -f "$STUBDIR/status-$runid" ] || exit 1
        # One status per line is served one per call, the last line repeating
        # forever: lets a case model a cancellation that lands N polls late.
        n=$(cat "$STUBDIR/status-$runid.count" 2>/dev/null || echo 0)
        n=$((n + 1))
        printf '%s\n' "$n" > "$STUBDIR/status-$runid.count"
        total=$(wc -l < "$STUBDIR/status-$runid")
        [ "$n" -le "$total" ] || n=$total
        sed -n "${n}p" "$STUBDIR/status-$runid"
        ;;
      *) exit 1 ;;
    esac
    ;;
  run)
    sub=$2
    runid=$3
    case "$sub" in
      cancel)
        printf '%s\n' "$runid" >> "$STUBDIR/cancel-calls"
        exit "$(cat "$STUBDIR/cancel-exit-$runid" 2>/dev/null || echo 0)"
        ;;
      rerun)
        printf '%s\n' "$runid" >> "$STUBDIR/rerun-calls"
        exit "$(cat "$STUBDIR/rerun-exit-$runid" 2>/dev/null || echo 0)"
        ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/gh"

# run_case <case-dir> <shell> <threshold-minutes> -> sets CASE_RC and CASE_OUT
run_case() {
  _dir=$1; _shell=$2; _threshold=$3
  # USE_DEFAULT_POLL=1 leaves the attempts override unset so the case runs
  # against the script's PRODUCTION poll bound (interval still 0 for speed).
  set +e
  CASE_OUT=$(
    if [ "${USE_DEFAULT_POLL:-0}" != 1 ]; then RERUN_STUCK_QUEUE_POLL_ATTEMPTS=2; export RERUN_STUCK_QUEUE_POLL_ATTEMPTS; fi
    STUBDIR="$_dir" PATH="$TMP/bin:$PATH" GITHUB_REPOSITORY=o/r \
      RERUN_STUCK_QUEUE_POLL_INTERVAL=0 \
      "$_shell" "$SCRIPT" "$_threshold" 2>&1)
  CASE_RC=$?
  set -e
}

SHELLS="sh"
if command -v bash >/dev/null 2>&1; then SHELLS="$SHELLS bash"; fi
HAVE_DASH=0
if command -v dash >/dev/null 2>&1 && dash -c 'exit 0' >/dev/null 2>&1; then
  SHELLS="$SHELLS dash"; HAVE_DASH=1
fi

# assert_case <name> <dir> <threshold> <rc> <needle> <want-cancel:yes|no> <want-rerun:yes|no> [needle2] [absent]
assert_case() {
  _name=$1; _dir=$2; _thr=$3; _rc=$4; _needle=$5; _wantc=$6; _wantr=$7; _needle2=${8:-}; _absent=${9:-}
  for _sh in $SHELLS; do
    rm -f "$_dir/cancel-calls" "$_dir/rerun-calls" "$_dir/list-calls" "$_dir/unfiltered-list-call" "$_dir"/status-*.count
    run_case "$_dir" "$_sh" "$_thr"
    if [ "$CASE_RC" != "$_rc" ]; then
      bad "$_name [$_sh]" "expected exit $_rc, got $CASE_RC — $CASE_OUT"
      return
    fi
    case "$CASE_OUT" in
      *"$_needle"*) : ;;
      *) bad "$_name [$_sh]" "expected output containing [$_needle], got [$CASE_OUT]"; return ;;
    esac
    if [ -n "$_needle2" ]; then
      case "$CASE_OUT" in
        *"$_needle2"*) : ;;
        *) bad "$_name [$_sh]" "expected output containing [$_needle2], got [$CASE_OUT]"; return ;;
      esac
    fi
    if [ -n "$_absent" ]; then
      case "$CASE_OUT" in
        *"$_absent"*) bad "$_name [$_sh]" "output must NOT contain [$_absent], got [$CASE_OUT]"; return ;;
      esac
    fi
    if [ "$_wantc" = yes ] && [ ! -f "$_dir/cancel-calls" ]; then
      bad "$_name [$_sh]" "expected a cancel, none was triggered"; return
    fi
    if [ "$_wantc" = no ] && [ -f "$_dir/cancel-calls" ]; then
      bad "$_name [$_sh]" "a cancel was triggered and must not have been"; return
    fi
    if [ "$_wantr" = yes ] && [ ! -f "$_dir/rerun-calls" ]; then
      bad "$_name [$_sh]" "expected a re-run, none was triggered"; return
    fi
    if [ "$_wantr" = no ] && [ -f "$_dir/rerun-calls" ]; then
      bad "$_name [$_sh]" "a re-run was triggered and must not have been"; return
    fi
  done
  ok "$_name"
}

# All fixture runs use a fixed created_at for the RUN itself (irrelevant to
# the script -- it only reads JOB created_at), and vary run_attempt/name/
# status as each case needs. The tabsii-platform#1435 shape: workflow "CI",
# job "Terraform Validate & Security".
mk_runs_json() {
  # $1 = dest file, $2.. = "<id>,<attempt>,<status>,<name>" tuples
  _dest=$1; shift
  {
    printf '{"workflow_runs":['
    _first=1
    for _t in "$@"; do
      _id=${_t%%,*}; _rest=${_t#*,}
      _attempt=${_rest%%,*}; _rest=${_rest#*,}
      _status=${_rest%%,*}; _name=${_rest#*,}
      [ "$_first" = 1 ] || printf ','
      _first=0
      printf '{"id":%s,"run_attempt":%s,"status":"%s","name":"%s"}' "$_id" "$_attempt" "$_status" "$_name"
    done
    printf ']}'
  } > "$_dest"
}

# mk_jobs <dest> <status> <age-seconds-ago>   -- one job, queued (or not)
mk_jobs_one() {
  _dest=$1; _status=$2; _age=$3
  printf '{"jobs":[{"id":900001,"status":"%s","name":"Terraform Validate \\u0026 Security","created_at":"%s"}]}' \
    "$_status" "$(iso_ago "$_age")" > "$_dest"
}

# ---------------------------------------------------------------------------
# Case 1 -- MUST-CATCH: queued past threshold, watched workflow, attempt 1.
# Threshold 1 minute (60s); job queued 90s ago.
# ---------------------------------------------------------------------------
C="$TMP/1-catch"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "111,1,in_progress,CI"
mk_jobs_one "$C/jobs-111" queued 90
printf 'completed\n' > "$C/status-111"
assert_case "queued past threshold on a watched workflow is cancelled and re-run" \
  "$C" 1 0 "re-ran run 111 once" yes yes

# ---------------------------------------------------------------------------
# Case 2 -- MUST-NOT-CATCH: queued, but younger than threshold.
# ---------------------------------------------------------------------------
C="$TMP/2-young"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "112,1,in_progress,CI"
mk_jobs_one "$C/jobs-112" queued 10
assert_case "a job queued but younger than the threshold is left alone" \
  "$C" 1 0 "inspected 1 candidate run(s), 0 stuck" no no

# ---------------------------------------------------------------------------
# Case 3 -- MUST-NOT-CATCH: run_attempt == 2 (once-only guard). Filtered by
# the script's own jq before this run's jobs are ever fetched.
# ---------------------------------------------------------------------------
C="$TMP/3-attempt2"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "113,2,in_progress,CI"
mk_jobs_one "$C/jobs-113" queued 999
assert_case "an already-re-run (attempt 2) run is never reconsidered" \
  "$C" 1 0 "no active first-attempt run" no no

# ---------------------------------------------------------------------------
# Case 4 -- MUST-NOT-CATCH: unwatched workflow name (a deploy lane). Also
# filtered by the script's own jq, not by the fixture -- proves the real
# `.name == "CI" or ...` filter, not an assumption about it.
# ---------------------------------------------------------------------------
C="$TMP/4-unwatched"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "114,1,in_progress,Deploy Application"
mk_jobs_one "$C/jobs-114" queued 999
assert_case "an unwatched (deploy) workflow is never inspected" \
  "$C" 1 0 "no active first-attempt run" no no

# ---------------------------------------------------------------------------
# Case 5 -- MUST-NOT-CATCH: run has no queued job (already in_progress).
# ---------------------------------------------------------------------------
C="$TMP/5-noqueued"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "115,1,in_progress,CI"
mk_jobs_one "$C/jobs-115" in_progress 999
assert_case "a run with no queued job is left alone" \
  "$C" 1 0 "inspected 1 candidate run(s), 0 stuck" no no

# ---------------------------------------------------------------------------
# Case 6 -- no active runs at all.
# ---------------------------------------------------------------------------
C="$TMP/6-none"; mkdir -p "$C"
mk_runs_json "$C/runs.json"
assert_case "no active runs of a watched workflow is a clean no-op" \
  "$C" 1 0 "no active first-attempt run" no no

# ---------------------------------------------------------------------------
# Case 7 -- COULD-NOT-TELL: the run-listing API call itself fails (no fixture).
# ---------------------------------------------------------------------------
C="$TMP/7-listfail"; mkdir -p "$C"
assert_case "an unreadable run list fails loudly, not silently" \
  "$C" 1 1 "could not list active runs" no no

# ---------------------------------------------------------------------------
# Case 8 -- COULD-NOT-TELL: the run reads, but its jobs listing does not.
# ---------------------------------------------------------------------------
C="$TMP/8-jobsfail"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "118,1,in_progress,CI"
# no jobs-118 fixture -> stub exits 1
assert_case "an unreadable jobs list fails loudly" \
  "$C" 1 1 "could not list jobs for run 118" no no

# ---------------------------------------------------------------------------
# Case 9 -- COULD-NOT-TELL: cancellation accepted, never confirms completed.
# Poll attempts/interval overridden by the harness (2 attempts, 0s) so this
# stays fast; the status fixture never reports "completed".
# ---------------------------------------------------------------------------
C="$TMP/9-neverconfirms"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "119,1,in_progress,CI"
mk_jobs_one "$C/jobs-119" queued 90
printf 'in_progress\n' > "$C/status-119"
# #2101: the run is now completed/cancelled once the cancel lands, which the
# next poll's filter excludes -- so the old "leaving the re-run to the next
# scheduled poll" promise was false. The message must instead name the manual
# re-run and must not make the false promise.
assert_case "a cancellation that never confirms completed is reported, not assumed, and names the manual re-run" \
  "$C" 1 1 "never confirmed completed" yes no "gh run rerun 119" "leaving the re-run to the next scheduled poll"

# ---------------------------------------------------------------------------
# Case 10 -- the cancel call itself is refused by the API.
# ---------------------------------------------------------------------------
C="$TMP/10-cancelrefused"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "120,1,in_progress,CI"
mk_jobs_one "$C/jobs-120" queued 90
printf '1\n' > "$C/cancel-exit-120"
assert_case "a refused cancel reports its own outcome and never re-runs" \
  "$C" 1 2 "cancel of run 120 was refused" yes no

# ---------------------------------------------------------------------------
# Case 11 -- cancel confirmed, but the re-run call itself is refused.
# ---------------------------------------------------------------------------
C="$TMP/11-rerunrefused"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "121,1,in_progress,CI"
mk_jobs_one "$C/jobs-121" queued 90
printf 'completed\n' > "$C/status-121"
printf '1\n' > "$C/rerun-exit-121"
assert_case "a refused re-run (after a confirmed cancel) reports its own outcome" \
  "$C" 1 2 "re-run of run 121 was refused" yes yes

# ---------------------------------------------------------------------------
# Case 12 -- REGRESSION for the pipe/subshell class: two runs in one
# invocation. Run 122 is genuinely stuck and succeeds end-to-end (exit 0 on
# its own). Run 123's jobs listing fails (exit 1 on its own). If the loop's
# `worst` tracking were lost to a subshell (the exact bug this script's own
# header documents fixing), the aggregate exit would read 0 -- a real
# failure silently swallowed by an unrelated success in the same run. Both
# runs must still be visibly processed: 122 cancelled+re-run, 123 reported.
# ---------------------------------------------------------------------------
C="$TMP/12-mixed"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "122,1,in_progress,CI" "123,1,in_progress,CI"
mk_jobs_one "$C/jobs-122" queued 90
printf 'completed\n' > "$C/status-122"
# no jobs-123 fixture -> that run's jobs listing fails
assert_case "one stuck+succeeding run and one undetermined run: the undetermined exit code wins, and both are processed" \
  "$C" 1 1 "could not list jobs for run 123" yes yes "re-ran run 122 once"

# ---------------------------------------------------------------------------
# Case 13 -- MUST-CATCH, multi-word workflow name. "RLS Tests" is one of only
# three watched names and the only one with an internal space; it must
# survive the TSV round-trip through `read -r run_id workflow_name` intact
# (IFS is a bare tab, so the space stays part of the one remaining field)
# rather than being split or truncated.
# ---------------------------------------------------------------------------
C="$TMP/13-multiword"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "124,1,in_progress,RLS Tests"
mk_jobs_one "$C/jobs-124" queued 90
printf 'completed\n' > "$C/status-124"
assert_case "a multi-word watched workflow name (RLS Tests) survives intact" \
  "$C" 1 0 "run 124 (RLS Tests) has a job queued" yes yes

# ---------------------------------------------------------------------------
# Case 14 -- #2100: the run list must be filtered SERVER-side. The fixture
# carries a completed-run history (what makes an unfiltered --paginate walk
# 111 pages on a real repo) plus one genuinely stuck run. Every list call must
# carry status=; the unfiltered call must never be made; both `queued` and
# `in_progress` must be asked for; and the denominator must be printed.
# ---------------------------------------------------------------------------
C="$TMP/14-serverfilter"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "201,1,completed,CI" "202,1,completed,CI" "203,1,completed,RLS Tests" \
  "204,1,completed,Release Guards" "205,1,completed,CI" "131,1,in_progress,CI"
mk_jobs_one "$C/jobs-131" queued 90
printf 'completed\n' > "$C/status-131"
assert_case "the run list is filtered server-side and the listed count is printed" \
  "$C" 1 0 "listed 0 queued and 1 in_progress" yes yes "re-ran run 131 once"
for _sh in $SHELLS; do
  rm -f "$C/list-calls" "$C/unfiltered-list-call" "$C/cancel-calls" "$C/rerun-calls" "$C"/status-*.count
  run_case "$C" "$_sh" 1
  if [ -f "$C/unfiltered-list-call" ]; then
    bad "server-side status filter [$_sh]" "an unfiltered actions/runs listing was made (walks the whole history)"
  elif ! grep -qx queued "$C/list-calls" 2>/dev/null || ! grep -qx in_progress "$C/list-calls" 2>/dev/null; then
    bad "server-side status filter [$_sh]" "expected a status=queued AND a status=in_progress listing, got [$(cat "$C/list-calls" 2>/dev/null)]"
  else
    ok "server-side status filter: only status=queued and status=in_progress are listed [$_sh]"
  fi
done

# ---------------------------------------------------------------------------
# Case 15 -- a whole RUN in status `queued` (not merely a job) is found by the
# status=queued listing.
# ---------------------------------------------------------------------------
C="$TMP/15-runqueued"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "132,1,queued,CI" "206,1,completed,CI"
mk_jobs_one "$C/jobs-132" queued 90
printf 'completed\n' > "$C/status-132"
assert_case "a run whose own status is queued is found by the queued listing" \
  "$C" 1 0 "listed 1 queued and 0 in_progress" yes yes "re-ran run 132 once"

# ---------------------------------------------------------------------------
# Case 16 -- #2101: a cancellation that lands LATE. The run reports
# in_progress for 9 reads, then completed on the 10th. The production poll
# bound (USE_DEFAULT_POLL=1) must be long enough to ride that out and re-run;
# the old 6-read bound gave up, and the run was left completed/cancelled and
# filtered out of every later poll -- never re-run.
# ---------------------------------------------------------------------------
C="$TMP/16-latecancel"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "133,1,in_progress,CI"
mk_jobs_one "$C/jobs-133" queued 90
{ i=0; while [ "$i" -lt 9 ]; do printf 'in_progress\n'; i=$((i+1)); done; printf 'completed\n'; } > "$C/status-133"
USE_DEFAULT_POLL=1
assert_case "a cancellation confirmed late (10th read) is still re-run under the production poll bound" \
  "$C" 1 0 "re-ran run 133 once" yes yes
USE_DEFAULT_POLL=0

# ---------------------------------------------------------------------------
# Cases 17-19 -- the run listing's could-not-tell paths (each a handler the
# #2100 rewrite added). Any of them must be loud (exit 1) and must never act.
# 17: the SECOND listing (in_progress) fails after the first (queued) read
#     fine -- a half-read denominator must not pass as "nothing stuck".
# 18: the listing is not JSON at all.
# 19: the listing parses as JSON but is not run objects (a bare scalar), so
#     the candidate filter itself errors.
# ---------------------------------------------------------------------------
C="$TMP/17-secondlistfail"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "141,1,queued,CI"
mk_jobs_one "$C/jobs-141" queued 90
printf 'completed\n' > "$C/status-141"
: > "$C/fail-list-in_progress"
assert_case "a failing in_progress listing fails loudly even though queued read fine" \
  "$C" 1 1 "could not list active runs (status=in_progress)" no no

C="$TMP/18-garbage"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "142,1,queued,CI"
printf 'not json {\n' > "$C/garbage-list"
assert_case "an unparseable run listing fails loudly" \
  "$C" 1 1 "could not parse the queued run listing" no no

C="$TMP/19-scalar"; mkdir -p "$C"
mk_runs_json "$C/runs.json" "143,1,queued,CI"
printf '7\n' > "$C/garbage-list"
assert_case "a run listing that is not run objects fails loudly" \
  "$C" 1 1 "could not evaluate the listed runs" no no

if [ "$HAVE_DASH" -eq 0 ]; then
  printf '\n  NOTE: dash is not installed here, so no case was checked under it.\n'
  printf '        That is "could not run", NOT a pass — see #1652.\n'
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
