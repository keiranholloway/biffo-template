#!/usr/bin/env sh
#
# Guard for #1741: the arg parser's catch-all case (`*) ISSUE="$1"; shift ;;`)
# used to swallow ANY unrecognized token, including one that starts with `-`
# and looks like an unsupported flag. A caller who typed a flag claim.sh does
# not support -- e.g. a stale `--non-interactive`, which has never been a real
# flag on any version of this script -- silently had ISSUE set to the flag
# text instead of the real issue number, and the script went on to fail the
# `case "$ISSUE" in '' | *[!0-9]*)` check a few lines later with "give an
# issue number" -- a message that describes the SYMPTOM (ISSUE is not
# numeric) while hiding the actual CAUSE (an unsupported flag was typed).
#
# The fix inserts a `-*)` arm ahead of the catch-all: any token starting with
# `-` that matches none of the known flag cases is refused immediately with
# "unrecognized flag", rather than falling through and corrupting ISSUE. This
# guard proves two things every future change to the parser must keep true:
#
#   1. An unrecognized flag is rejected outright (exit 2, a clear message),
#      never silently accepted as the issue number.
#   2. Every documented flag -- --as, --check, --release, --guard, -R/--repo,
#      -h/--help, and the combined `--release --as <token>` form (#826) --
#      still parses and behaves exactly as before.
#
# Run: sh scripts/claim-unrecognized-flag-rejected.test.sh
# Exit 0 = both properties hold. Exit 1 = a regression.

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
CLAIM="$REPO_ROOT/scripts/claim.sh"
STUB_DIR=$(mktemp -d)
NO_FLEET_DIR="$STUB_DIR/no-fleet"
trap 'rm -rf "$STUB_DIR"' EXIT

REAL_GIT=$(command -v git)
fail=0

report() {
  echo "FAIL: $1" >&2
  fail=1
}

# --- Fake `gh` -----------------------------------------------------------
#
# One stub covers every scenario below, distinguished by the argument list
# the same way the other scripts/*.test.sh stubs do. Anything not listed is
# an unexpected invocation and fails loudly, so a scenario that reaches
# further than intended is caught rather than silently passing on an empty
# stdout.
cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env sh
set -u

case "$*" in
  "issue view 999101 --json state,title,labels"*)
    printf 'OPEN\tFree test issue\t\n'; exit 0 ;;
  "issue view 999101 --json updatedAt"*) printf '\n'; exit 0 ;;
  "issue view 999102 --json state,title,labels"*)
    printf 'OPEN\tClaim test issue\t\n'; exit 0 ;;
  "issue view 999102 --json updatedAt"*) printf '\n'; exit 0 ;;
  "issue view 999103 --json comments"*)
    printf 'Claimed at 2026-01-01T00:00:00Z. claim-holder:tok-relas-0101 claim-branch:fix/999103-x\n'
    exit 0 ;;
  "issue edit 999103 --remove-label in-progress"*) exit 0 ;;
  "pr list --state open"*) exit 0 ;;
  "pr list --state merged"*) exit 0 ;;
  "label create"*) exit 0 ;;
  "issue edit 999102 --add-label in-progress"*) exit 0 ;;
  "issue comment 999102"*) exit 0 ;;
esac

echo "unexpected gh invocation: $*" >&2
exit 1
STUB
chmod +x "$STUB_DIR/gh"

# --- Fake `git` ------------------------------------------------------------
#
# Only `ls-remote` is intercepted (report no remote branches, no network);
# everything else -- `rev-parse`, `config`, `cat-file` -- delegates to the
# real binary, since none of it is what this test exercises.
cat > "$STUB_DIR/git" <<STUB
#!/usr/bin/env sh
set -u
if [ "\$1" = "ls-remote" ]; then
  exit 0
fi
exec "$REAL_GIT" "\$@"
STUB
chmod +x "$STUB_DIR/git"

run() {
  PATH="$STUB_DIR:$PATH" FLEET_DIR="$NO_FLEET_DIR" sh "$CLAIM" "$@" 2>&1
}

# === 1. An unrecognized flag is refused, never silently taken as ISSUE =====

out=$(run --bogus)
status=$?
if [ "$status" -ne 2 ]; then
  report "'--bogus' alone exited $status, expected 2 (cannot tell / rejected)."
fi
if ! printf '%s' "$out" | grep -qi "unrecognized flag"; then
  report "'--bogus' alone did not report 'unrecognized flag'. Got: $out"
fi
if printf '%s' "$out" | grep -qi "give an issue number"; then
  report "'--bogus' alone fell through to the ISSUE-not-numeric message -- the catch-all swallowed it. Got: $out"
fi

out=$(run 1234 --bogus)
status=$?
if [ "$status" -ne 2 ]; then
  report "'1234 --bogus' exited $status, expected 2."
fi
if ! printf '%s' "$out" | grep -qi "unrecognized flag '--bogus'"; then
  report "'1234 --bogus' did not name the flag it rejected. Got: $out"
fi

out=$(run --non-interactive 1234 --as tok-abc-0101)
status=$?
if [ "$status" -ne 2 ]; then
  report "'--non-interactive' (the exact flag #1741 was filed about) exited $status, expected 2."
fi
if ! printf '%s' "$out" | grep -qi "unrecognized flag '--non-interactive'"; then
  report "'--non-interactive' was not named as the rejected flag. Got: $out"
fi

# === 2. Every documented flag still parses and behaves as before ===========

# -h / --help
for h in -h --help; do
  out=$(run "$h")
  status=$?
  if [ "$status" -ne 2 ]; then
    report "'$h' exited $status, expected 2 (usage)."
  fi
  if ! printf '%s' "$out" | grep -q "sh scripts/claim.sh 1234 --as <token>"; then
    report "'$h' did not print the usage text. Got: $out"
  fi
done

# -R / --repo, proven by chaining into -h so a parse failure would surface
# as "unrecognized flag" instead of the expected usage text.
for r in -R --repo; do
  out=$(run "$r" owner/repo -h)
  status=$?
  if [ "$status" -ne 2 ] || ! printf '%s' "$out" | grep -q "sh scripts/claim.sh 1234 --as <token>"; then
    report "'$r owner/repo -h' did not reach usage cleanly (repo flag mis-parsed?). Got: $out (exit $status)"
  fi
done

# --guard <branch>: a branch naming no issue skips silently before any
# network call -- the cleanest proof the flag's value was consumed correctly.
out=$(run --guard some-branch-with-no-issue-number)
status=$?
if [ "$status" -ne 0 ] || [ -n "$out" ]; then
  report "'--guard some-branch-with-no-issue-number' expected silent exit 0. Got exit $status, output: $out"
fi

# --release with no token: refused deterministically before any network call,
# proving RELEASE=1 was set and the (missing) value handling still runs.
out=$(run --release)
status=$?
if [ "$status" -ne 1 ]; then
  report "'--release' with no token exited $status, expected 1."
fi
if ! printf '%s' "$out" | grep -qi "needs the token"; then
  report "'--release' with no token did not ask for one. Got: $out"
fi

# --as <token> with no issue: reaches the ISSUE-not-numeric check (proving
# --as consumed its value rather than being rejected as unrecognized).
out=$(run --as tok-noissue-0101)
status=$?
if [ "$status" -ne 2 ] || ! printf '%s' "$out" | grep -qi "give an issue number"; then
  report "'--as tok-noissue-0101' with no ISSUE did not reach the expected downstream check. Got: $out (exit $status)"
fi
if printf '%s' "$out" | grep -qi "unrecognized flag"; then
  report "'--as' was rejected as an unrecognized flag. Got: $out"
fi

# --check, full round-trip against a free issue.
out=$(run 999101 --check --as tok-check-0101 -R fake-owner/fake-repo)
status=$?
if [ "$status" -ne 0 ] || ! printf '%s' "$out" | grep -q "Free\."; then
  report "'--check' on a free issue did not report Free. Got: $out (exit $status)"
fi

# --as, full round-trip: actually claims a free issue.
out=$(run 999102 --as tok-claim-0101 -R fake-owner/fake-repo)
status=$?
if [ "$status" -ne 0 ] || ! printf '%s' "$out" | grep -q "Claimed\."; then
  report "'--as' on a free issue did not report Claimed. Got: $out (exit $status)"
fi

# --release <token> and the combined --release --as <token> form (#826):
# both must still release a claim actually held by that token.
out=$(run 999103 --release tok-relas-0101 -R fake-owner/fake-repo)
status=$?
if [ "$status" -ne 0 ] || ! printf '%s' "$out" | grep -q "Released\."; then
  report "'--release tok-relas-0101' did not release. Got: $out (exit $status)"
fi

out=$(run 999103 --release --as tok-relas-0101 -R fake-owner/fake-repo)
status=$?
if [ "$status" -ne 0 ] || ! printf '%s' "$out" | grep -q "Released\."; then
  report "'--release --as tok-relas-0101' (the combined form #826 fixed) did not release. Got: $out (exit $status)"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "PASS: an unrecognized flag is refused with a clear message instead of being"
echo "      swallowed as the issue number, and every documented flag still works."
exit 0
