#!/usr/bin/env bash
# Self-test: rehearse_repo reports `verify inconclusive: <lanes>` as its own
# INCONCLUSIVE verdict with those lanes, never as FAIL with a tail -1 fragment.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# Pull just the two functions out of shared-sync.sh (the script runs main on source).
for f in install_gate_deps rehearse_repo; do
  awk -v f="$f" '$0 ~ "^"f"\\(\\) \\{"{p=1} p{print} p&&/^}/{exit}' "$ROOT/scripts/shared-sync.sh" >> "$TMP/fns.sh"
done
TEMPLATE_ROOT="$TMP/none"; export TEMPLATE_ROOT
. "$TMP/fns.sh"

mk() { mkdir -p "$TMP/$1/scripts"; printf '%s\n' "$2" > "$TMP/$1/scripts/biffo.sh"; }
fail=0
check() { # name expected-prefix actual
  case "$3" in "$2"*) echo "  ok   $1" ;; *) echo "  FAIL $1: got [$3]"; fail=1 ;; esac
}

mk inc 'echo "INCONCLUSIVE dependencies not installed"
echo "verify inconclusive: lint(apps/frontend) typecheck(apps/frontend)"
echo "This is not a failure, do not go looking for a bug."
exit 2'
out=$(rehearse_repo "$TMP/inc") || true
check inconclusive-verdict "INCONCLUSIVE	lint(apps/frontend) typecheck(apps/frontend)" "$out"

mk fail 'echo "verify failed: lint"; echo "tail"; exit 1'
out=$(rehearse_repo "$TMP/fail") || true
check fail-still-fail "FAIL	verify failed: lint" "$out"

mk pass 'echo "verify passed - lint test"; exit 0'
out=$(rehearse_repo "$TMP/pass") || true
check pass "PASS" "$out"
exit $fail
