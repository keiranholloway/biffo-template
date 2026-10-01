#!/usr/bin/env bash
#
# Self-test for scripts/shared-sync-report.sh (biffo-template#2166): the
# red/green and issue-routing decision of shared-sync-report.yml.
#
# `gh` is stubbed on PATH; the real jq, git and date run. Cases:
#   1 clean                                   -> green, no issue
#   2 fresh drift, PR opened                  -> green, issue created/updated
#   3 unreadable repo                         -> red
#   4 delivery round failed                   -> red
#   5 drift older than 48h (stuck PR)         -> red
#   6 closed issue (marker), report still true-> reopened, same number
#   7 open issue                              -> commented, not recreated
#   8 --check did not complete                -> red
#   9 legacy closed issue (title, no marker)  -> reopened
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$ROOT/scripts/shared-sync-report.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'STUB'
#!/bin/sh
echo "gh $*" >> "$STUBDIR/calls"
case "$1 $2" in
  "issue list") cat "$STUBDIR/issues.json" ;;
  "issue create") echo "https://example/issues/999" ;;
  "issue reopen"|"issue comment") : ;;
  "pr list")
    [ ! -f "$STUBDIR/pr-fail" ] || exit 1
    cat "$STUBDIR/pr-created" 2>/dev/null || true ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/gh"

iso_ago() { date -u -d "@$(( $(date +%s) - $1 ))" +%Y-%m-%dT%H:%M:%SZ; }

TITLE="shared-sync scheduled report: satellite drift or an unreadable repo detected"
MARK='<!-- shared-sync-report -->'

# run <case> <drifted:0|1> <unreadable:0|1> <delivery> <pr-age-sec|none> <issues-json> [check-outcome]
run() {
  c=$1; drift=$2; unread=$3; delivery=$4; age=$5; issues=$6; sync_outcome=${7:-success}
  d="$TMP/$c"; mkdir -p "$d/estate/sat-a"
  git init -q "$d/estate/sat-a"
  git -C "$d/estate/sat-a" remote add origin https://github.com/o/sat-a.git
  {
    if [ "$drift" = 1 ]; then printf 'sat-a                      \033[31mDRIFTED\033[0m scripts/x.sh\n'; fi
    if [ "$unread" = 1 ]; then printf 'sat-b                      \033[31mcannot fetch\033[0m - boom\n'; fi
    printf '\n3 of 4 repo(s) under /e judged applicable by applies()\n'
    printf '%s current, %s drifted\n' "$((2 - drift))" "$drift"
  } > "$d/check.log"
  [ "$age" = none ] || iso_ago "$age" > "$d/pr-created"
  printf '%s' "$issues" > "$d/issues.json"
  rc=0; [ "$drift" = 1 ] && rc=1
  [ "$unread" = 1 ] && rc=1
  set +e
  STUBDIR="$d" PATH="$TMP/bin:$PATH" ESTATE_OUTCOME=success SYNC_OUTCOME="$sync_outcome" \
    CHECK_RC="$rc" CHECK_LOG="$d/check.log" DELIVERY_OUTCOME="$delivery" CLONED=4 \
    ESTATE="$d/estate" RUN_URL=http://run GITHUB_REPOSITORY=o/tmpl GH_TOKEN=x \
    SUMMARY_FILE="$d/summary" bash "$SCRIPT" > "$d/out" 2>&1
  RC=$?
  set -e
  CALLS="$d/calls"; [ -f "$CALLS" ] || : > "$CALLS"
  OUT="$d/out"
}
calls_has() { grep -q -- "$1" "$CALLS"; }
no_issue_write() { ! grep -qE 'issue (create|comment|reopen)' "$CALLS"; }

echo "self-test: shared-sync-report red/green + issue routing (#2166)"

run c1 0 0 skipped none '[]'
if [ "$RC" -eq 0 ] && no_issue_write; then ok "1 clean -> green, no issue"; else bad "1 clean" "rc=$RC $(cat "$CALLS")"; fi

run c2 1 0 success 3600 '[]'
if [ "$RC" -eq 0 ] && calls_has 'issue create'; then ok "2 fresh drift + PR -> green, issue filed"; else bad "2" "rc=$RC $(cat "$OUT")"; fi
grep -q "$MARK" "$CALLS" && ok "2b issue body carries the stable marker" || bad "2b marker missing"

run c2u 1 0 success 3600 "[{\"number\":7,\"state\":\"OPEN\",\"title\":\"x\",\"body\":\"$MARK\"}]"
if [ "$RC" -eq 0 ] && calls_has 'issue comment.* 7 ' && ! calls_has 'issue create' && ! calls_has 'issue reopen'; then
  ok "7 open issue -> commented, not recreated"; else bad "7" "rc=$RC $(cat "$CALLS")"; fi

run c3 0 1 skipped none '[]'
[ "$RC" -eq 1 ] && ok "3 unreadable repo -> red" || bad "3" "rc=$RC"

run c4 1 0 failure 3600 '[]'
[ "$RC" -eq 1 ] && ok "4 delivery failed -> red" || bad "4" "rc=$RC"

run c5 1 0 success $((49 * 3600)) '[]'
[ "$RC" -eq 1 ] && ok "5 drift older than 48h -> red" || bad "5" "rc=$RC"

run c6 1 0 success 3600 "[{\"number\":42,\"state\":\"CLOSED\",\"title\":\"x\",\"body\":\"$MARK\"}]"
if [ "$RC" -eq 0 ] && calls_has 'issue reopen.* 42' && calls_has 'issue comment.* 42' && ! calls_has 'issue create'; then
  ok "6 closed still-true report -> reopened, same number"; else bad "6" "rc=$RC $(cat "$CALLS")"; fi

run c8 0 0 skipped none '[]' failure
[ "$RC" -eq 1 ] && ok "8 --check incomplete -> red" || bad "8" "rc=$RC"

run c9 1 0 success 3600 "[{\"number\":5,\"state\":\"CLOSED\",\"title\":\"$TITLE\",\"body\":\"old\"}]"
if [ "$RC" -eq 0 ] && calls_has 'issue reopen.* 5' && ! calls_has 'issue create'; then
  ok "9 legacy closed issue (title only) -> reopened"; else bad "9" "rc=$RC $(cat "$CALLS")"; fi

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
