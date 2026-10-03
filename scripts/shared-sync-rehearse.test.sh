#!/usr/bin/env bash
# Self-test: rehearse_repo reports `verify inconclusive: <lanes>` as its own
# INCONCLUSIVE verdict with those lanes, never as FAIL with a tail -1 fragment.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# Pull just the two functions out of shared-sync.sh (the script runs main on source).
for f in install_gate_deps _install_err_line regen_pnpm_lock apply_overrides_floor rehearse_repo; do
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

# install failure prints pnpm's own error code in the warning
mkdir -p "$TMP/bin" "$TMP/wi/pkg"
printf '{}\n' > "$TMP/wi/pkg/package.json"
printf '#!/bin/sh\necho "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed"\nexit 1\n' > "$TMP/bin/pnpm"
chmod +x "$TMP/bin/pnpm"
err=$(PATH="$TMP/bin:$PATH" install_gate_deps "$TMP/wi" 2>&1 >/dev/null)
check install-warning-has-code "    warning: pnpm install --frozen-lockfile failed in pkg: ERR_PNPM_LOCKFILE_CONFIG_MISMATCH" "$err"

# override delivery regenerates the lockfile; frozen install then succeeds
if command -v pnpm >/dev/null 2>&1; then
  P="$TMP/sat/apps/frontend"; mkdir -p "$P"
  cat > "$P/package.json" <<'J'
{
  "name": "sat",
  "version": "1.0.0",
  "pnpm": {
    "overrides": {
      "a@<1.0.0": ">=1.0.0"
    }
  }
}
J
  cat > "$TMP/canon.json" <<'J'
{
  "pnpm": {
    "overrides": {
      "a@<1.0.0": ">=1.0.0",
      "b@<2.0.0": ">=2.0.0"
    }
  }
}
J
  (cd "$P" && pnpm install --ignore-workspace >/dev/null 2>&1) || true
  rm -rf "$P/node_modules"
  before=$(cat "$P/pnpm-lock.yaml" 2>/dev/null || true)
  (cd "$P" && pnpm install --frozen-lockfile --ignore-workspace >/dev/null 2>&1) && echo "  ok   baseline-frozen" || { echo "  FAIL baseline-frozen"; fail=1; }
  rm -rf "$P/node_modules"
  apply_overrides_floor "$P/package.json" "$TMP/canon.json" >/dev/null
  if (cd "$P" && pnpm install --frozen-lockfile --ignore-workspace >/dev/null 2>&1); then
    echo "  FAIL precondition: frozen install should fail before regen"; fail=1
  fi
  regen_pnpm_lock "$TMP/sat" apps/frontend/package.json || { echo "  FAIL regen"; fail=1; }
  grep -q 'b@<2.0.0' "$P/pnpm-lock.yaml" && echo "  ok   lock-has-new-override" || { echo "  FAIL lock-has-new-override"; fail=1; }
  (cd "$P" && pnpm install --frozen-lockfile --ignore-workspace >/dev/null 2>&1) && echo "  ok   frozen-after-regen" || { echo "  FAIL frozen-after-regen"; fail=1; }
else
  echo "  skip pnpm lockfile test (no pnpm)"
fi
exit $fail
