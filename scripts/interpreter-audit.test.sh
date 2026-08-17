#!/usr/bin/env sh
#
# Self-test for scripts/interpreter-audit.sh (#1625).
#
# #1619 shipped find_invocations()'s awk process() with a stale-RSTART/
# RLENGTH bug: the flag-skip and token-extraction match() calls overwrite
# the same RSTART/RLENGTH the interpreter match() had just set, and the
# line that advances past a parsed invocation (`rest = substr(rest, RSTART
# + RLENGTH)`) consumed those stale, wrongly-scoped offsets instead. Residue
# was left behind and rescanned as a bogus second invocation, landing
# wherever the interpolated script PATH LENGTH happened to put it -- so
# `scripts/foo.sh` passed, `scripts/foo2.sh` false-MISMATCHed on a phantom
# `sh` invocation nothing in the line names, and `scripts/a.sh` silently
# reported 2 invocations for 1 real one while still exiting 0 (#1625).
#
# This is the fixture matrix from #1625 itself (all four filenames), plus
# the five properties the fix had to keep holding: the founding sh-invokes-
# bash-shebang case (#1603), `sh -e` (flags between interpreter and script),
# both UNPARSEABLE shapes (`sh -c "..."`, a shell-variable interpreter), and
# this repo's own real workflows staying at 0 mismatched / 0 could-not-
# examine. Every case runs under BOTH bash and dash and asserts identical
# output — this class is a RUNTIME option-parse-adjacent residue bug, not a
# parse error, so `dash -n`/`bash -n` cannot catch it; only an executed run
# under the runner's actual /bin/sh can (the same lesson interpreter-audit.sh
# itself exists to enforce, one level up).
#
# Run: sh scripts/interpreter-audit.test.sh
# Exit 0 = every case behaves as specified. Exit 1 = a regression.

set -u
(set -o pipefail) 2>/dev/null && set -o pipefail || true

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
AUDIT="$REPO_ROOT/scripts/interpreter-audit.sh"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

FAILURES=0

# make_fixture <dir> <script-name> <run-line> [<second-run-line>]
#
# A disposable one-workflow, one-script git repo. interpreter-audit.sh needs
# a real git root (it calls `git rev-parse --show-toplevel` and `cd`s there)
# and reads .github/workflows/*.yml relative to it, so a bare directory of
# files is not enough to drive it.
make_fixture() {
  dir=$1
  script_name=$2
  run_line=$3
  run_line2=${4:-}
  mkdir -p "$dir/.github/workflows" "$dir/scripts"
  (
    cd "$dir" || exit 1
    git init -q
    git config user.email test@example.invalid
    git config user.name test
    printf '#!/usr/bin/env bash\necho hi\n' >"scripts/${script_name}.sh"
    chmod +x "scripts/${script_name}.sh"
    {
      echo 'name: w'
      echo 'on: push'
      echo 'jobs:'
      echo '  j:'
      echo '    runs-on: ubuntu-latest'
      echo '    steps:'
      echo "      - run: ${run_line}"
      if [ -n "$run_line2" ]; then
        echo "      - run: ${run_line2}"
      fi
    } >.github/workflows/w.yml
    git add -A
    git commit -q -m fixture
  )
}

# run_audit <dir> <shell> -- prints "<exit-code>\n<output>"
run_audit() {
  dir=$1
  shell=$2
  out=$(cd "$dir" && "$shell" "$AUDIT" 2>&1)
  code=$?
  printf '%s\n%s' "$code" "$out"
}

# invocation_count <audit-output>
invocation_count() {
  printf '%s\n' "$1" | grep -Eo '[0-9]+ explicit-interpreter invocation' | grep -Eo '^[0-9]+'
}

# assert_case <scenario-name> <dir> <expected-exit> <expected-invocations> <must-contain-or-empty> <must-not-contain-or-empty>
assert_case() {
  name=$1
  dir=$2
  expected_exit=$3
  expected_count=$4
  must_contain=$5
  must_not_contain=$6

  bash_result=$(run_audit "$dir" bash)
  bash_code=$(printf '%s' "$bash_result" | head -n1)
  bash_out=$(printf '%s' "$bash_result" | tail -n +2)

  dash_result=$(run_audit "$dir" dash)
  dash_code=$(printf '%s' "$dash_result" | head -n1)
  dash_out=$(printf '%s' "$dash_result" | tail -n +2)

  case_failed=0

  if [ "$bash_out" != "$dash_out" ] || [ "$bash_code" != "$dash_code" ]; then
    echo "FAIL: $name — bash and dash disagree" >&2
    echo "  bash: exit $bash_code" >&2
    echo "  dash: exit $dash_code" >&2
    echo "--- bash output ---" >&2
    printf '%s\n' "$bash_out" >&2
    echo "--- dash output ---" >&2
    printf '%s\n' "$dash_out" >&2
    case_failed=1
  fi

  if [ "$bash_code" != "$expected_exit" ]; then
    echo "FAIL: $name — expected exit $expected_exit, got $bash_code" >&2
    case_failed=1
  fi

  actual_count=$(invocation_count "$bash_out")
  if [ "$actual_count" != "$expected_count" ]; then
    echo "FAIL: $name — expected $expected_count invocation(s) found, got ${actual_count:-<none printed>}" >&2
    echo "  This is the #1625 denominator defect: a phantom or dropped invocation" >&2
    echo "  from stale awk RSTART/RLENGTH, not a mismatch/exit-code symptom." >&2
    case_failed=1
  fi

  if [ -n "$must_contain" ] && ! printf '%s' "$bash_out" | grep -qF "$must_contain"; then
    echo "FAIL: $name — expected output to contain: $must_contain" >&2
    case_failed=1
  fi

  if [ -n "$must_not_contain" ] && printf '%s' "$bash_out" | grep -qF "$must_not_contain"; then
    echo "FAIL: $name — output unexpectedly contains: $must_not_contain" >&2
    case_failed=1
  fi

  if [ "$case_failed" -ne 0 ]; then
    echo "--- full bash output ($name) ---" >&2
    printf '%s\n' "$bash_out" >&2
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: $name (exit $bash_code, $actual_count invocation(s), bash == dash)"
  fi
}

# --- #1625's own fixture matrix: same shape, four filenames -------------
# Every one of these is `run: bash scripts/<name>.sh` invoking a genuine
# bash-shebang script with the CORRECT interpreter. All four must report
# exactly 1 invocation, 0 mismatches, exit 0 — the bug made the outcome
# depend on <name>'s length instead.
for name in foo foo2 verify a; do
  d="$WORK/matrix-$name"
  make_fixture "$d" "$name" "bash scripts/${name}.sh"
  assert_case "matrix: bash scripts/${name}.sh (correct code)" "$d" 0 1 "" "MISMATCH"
done

# --- Must still hold: the founding case (#1603) --------------------------
# `sh` invoking a script whose shebang declares `bash` is the defect this
# whole audit exists to catch, and must still be caught after the fix.
d="$WORK/founding"
make_fixture "$d" "ci-wiring-audit" "sh scripts/ci-wiring-audit.sh"
assert_case "founding: sh invokes bash-shebang script" "$d" 1 1 "MISMATCH" ""

# --- Must still hold: the founding defect plus a flag ---------------------
d="$WORK/flags"
make_fixture "$d" "foo" "sh -e scripts/foo.sh"
assert_case "flags: sh -e invokes bash-shebang script" "$d" 1 1 "MISMATCH" ""

# --- Must still hold: unparseable shapes are counted, not dropped ---------
d="$WORK/unparseable"
make_fixture "$d" "foo" 'sh -c "scripts/foo.sh"' '${RUNNER_SHELL} scripts/foo.sh'
assert_case "unparseable: sh -c \"...\" and a shell-variable interpreter" "$d" 1 2 "COULD NOT EXAMINE" "MISMATCH"

# --- Must still hold: this repo's own real workflows -----------------------
# Not pinned to a fixed count (that grows as this repo's workflows do) —
# only to the properties #1625 cares about: nothing mismatched, nothing
# left unexamined, exit 0.
real_result=$(run_audit "$REPO_ROOT" bash)
real_code=$(printf '%s' "$real_result" | head -n1)
real_out=$(printf '%s' "$real_result" | tail -n +2)
real_dash_result=$(run_audit "$REPO_ROOT" dash)
real_dash_code=$(printf '%s' "$real_dash_result" | head -n1)
real_dash_out=$(printf '%s' "$real_dash_result" | tail -n +2)

if [ "$real_out" != "$real_dash_out" ] || [ "$real_code" != "$real_dash_code" ]; then
  echo "FAIL: real repo — bash and dash disagree" >&2
  FAILURES=$((FAILURES + 1))
elif [ "$real_code" != "0" ] \
  || ! printf '%s' "$real_out" | grep -q 'examined, mismatched:  *0' \
  || ! printf '%s' "$real_out" | grep -q 'could not examine:  *0'; then
  echo "FAIL: real repo — expected exit 0, 0 mismatched, 0 could not examine" >&2
  printf '%s\n' "$real_out" >&2
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: real repo — clean (exit $real_code, bash == dash)"
fi

echo
if [ "$FAILURES" -ne 0 ]; then
  echo "interpreter-audit.test.sh: $FAILURES check(s) failed."
  exit 1
fi

echo "interpreter-audit.test.sh: all checks passed."
exit 0
