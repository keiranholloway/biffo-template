#!/usr/bin/env sh
#
# Guard for #1691: `claim_held_by()` in claim.sh used to collapse two
# different facts onto the same `return 1` -- "the comment read failed" and
# "the read succeeded and found no match". Every caller then had no way to
# tell "cannot tell" from "determined: not held", with a different cost on
# each side:
#
#   - `--release` reported a confident-sounding "not held by '<token>'" for a
#     claim it never actually managed to read -- a false negative that makes
#     a genuinely-held claim look releasable-refused for the wrong reason,
#     and (read the other way) makes an unreadable check indistinguishable
#     from "definitely someone else's", so a stuck claim reads as certain
#     when it is really just unknown.
#   - the ordinary claim path's label check funnelled the same ambiguity
#     into `note()` (TAKEN=1), so an unreadable comment list was reported as
#     a confident "Taken" -- true by accident of always refusing, but for
#     the wrong stated reason, and structurally unable to ever surface
#     "cannot tell" (exit 2) for this signal at all.
#
# The fix makes `claim_held_by` tri-state (0 held / 1 not held / 2 cannot
# tell) and both callers branch on all three. This test stubs `gh` so the
# comments read fails (simulating a real `gh` HTTP/network error) while the
# issue's own metadata read succeeds, and checks that both the `--release`
# path and the ordinary claim path report the ambiguity HONESTLY:
#
#   - `--release` must say "cannot tell", not "not held by", and exit 2
#     (not the same 1 as a real mismatch).
#   - the claim path must still refuse (fail closed -- never grant a claim
#     over an unreadable holder) but report "Cannot tell", not a
#     over-confident "Taken", and exit 2 (not 1).
#
# Run: sh scripts/claim-comments-unreadable-tristate.test.sh
# Exit 0 = both paths report the ambiguity honestly and still refuse.
# Exit 1 = the pre-#1691 collapse is back (or a regression of the fix).

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
STUB_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR"' EXIT

REAL_GIT=$(command -v git)
ISSUE=999001
HOLDER_TOKEN=sess-abc

# --- Fake `gh` ---------------------------------------------------------------
#
# Distinguishes calls by the `--json` field list, the same way the real
# script's three separate `gh_issue view` calls differ from each other. The
# comments read is the one under test and always fails, simulating a real
# `gh` network/HTTP error -- never "found, but empty", which is a different,
# already-correct case.
cat > "$STUB_DIR/gh" <<STUB
#!/usr/bin/env sh
set -u

case "\$*" in
  "issue view $ISSUE --json state,title,labels"*)
    printf 'OPEN\tTest issue\tin-progress\n'
    exit 0
    ;;
  "issue view $ISSUE --json updatedAt"*)
    printf '2026-08-01T00:00:00Z\n'
    exit 0
    ;;
  "issue view $ISSUE --json comments"*)
    echo "gh: HTTP 502 (simulated network failure)" >&2
    exit 1
    ;;
  "pr list --state open"*)
    exit 0
    ;;
  "pr list --state merged"*)
    exit 0
    ;;
  "label create"*)
    exit 0
    ;;
  "issue edit"*)
    exit 0
    ;;
esac

echo "unexpected gh invocation: \$*" >&2
exit 1
STUB
chmod +x "$STUB_DIR/gh"

# --- Fake `git` ---------------------------------------------------------------
#
# Only `ls-remote` is intercepted (signal 3 -- a remote branch naming the
# issue): report none found, without ever touching the network. Everything
# else delegates to the real `git` binary, since claim.sh's own plumbing
# (`git rev-parse`, etc.) is not part of what this test exercises.
cat > "$STUB_DIR/git" <<STUB
#!/usr/bin/env sh
set -u
if [ "\$1" = "ls-remote" ]; then
  exit 0
fi
exec "$REAL_GIT" "\$@"
STUB
chmod +x "$STUB_DIR/git"

fail=0

# --- Scenario 1: --release on a claim the script cannot actually read -------

# Invoked as a bare executable path, not `sh "$REPO_ROOT/scripts/claim.sh"`
# -- claim.sh's own shebang is `#!/usr/bin/env sh` so this was never a
# runtime-crash risk, but the quoted variable path made it unresolvable to
# interpreter-audit.sh once that audit started reading scripts/*.sh (#1681):
# "could not examine" is the honest verdict for an invocation this audit
# cannot statically resolve, and a bare path resolves it like every other
# call site in this round.
release_output=$(PATH="$STUB_DIR:$PATH" "$REPO_ROOT/scripts/claim.sh" "$ISSUE" --release "$HOLDER_TOKEN" -R fake-owner/fake-repo 2>&1)
release_status=$?

if printf '%s' "$release_output" | grep -q "not held by"; then
  echo "FAIL: --release reported a confident 'not held by' for a claim it could not read." >&2
  echo "  An unreadable comments list is NOT the same fact as a determined mismatch." >&2
  fail=1
fi

if ! printf '%s' "$release_output" | grep -qi "cannot tell"; then
  echo "FAIL: --release did not say 'cannot tell' when the comments read failed." >&2
  fail=1
fi

if [ "$release_status" -ne 2 ]; then
  echo "FAIL: --release exited $release_status on an unreadable claim; expected 2 (cannot tell)." >&2
  fail=1
fi

# --- Scenario 2: ordinary claim path against a label it cannot verify -------

# Bare executable path -- see Scenario 1's comment above.
claim_output=$(PATH="$STUB_DIR:$PATH" "$REPO_ROOT/scripts/claim.sh" "$ISSUE" --as "$HOLDER_TOKEN" -R fake-owner/fake-repo 2>&1)
claim_status=$?

# Fail CLOSED either way: this must never report the issue free to claim.
if printf '%s' "$claim_output" | grep -qi "^Free\."; then
  echo "FAIL: the claim path reported #$ISSUE free when the label's holder could not be read." >&2
  echo "  An unreadable check must refuse to claim, never grant one (#1691)." >&2
  fail=1
fi

if printf '%s' "$claim_output" | grep -qi "^Claimed\."; then
  echo "FAIL: the claim path actually claimed #$ISSUE over an unreadable holder." >&2
  fail=1
fi

if ! printf '%s' "$claim_output" | grep -qi "Cannot tell"; then
  echo "FAIL: the claim path did not report 'Cannot tell' for an unreadable comments list." >&2
  echo "  It must not report a confident 'Taken' for ambiguity it cannot actually resolve." >&2
  fail=1
fi

if [ "$claim_status" -ne 2 ]; then
  echo "FAIL: the claim path exited $claim_status on an unreadable label holder; expected 2 (cannot tell)." >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "--- --release output ---" >&2
  printf '%s\n' "$release_output" >&2
  echo "--- claim output ---" >&2
  printf '%s\n' "$claim_output" >&2
  exit 1
fi

echo "PASS: an unreadable comments list is reported as 'cannot tell' (exit 2) on both the"
echo "      --release and claim paths, never as a false 'not held' or an over-confident 'Taken'."
exit 0
