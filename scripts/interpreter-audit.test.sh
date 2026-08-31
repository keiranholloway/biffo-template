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
# ## Fifth-pass fix: a missing `dash` was silently read as a regression (#1652)
#
# Every comparison below runs the audit under `dash` by literally invoking
# `"$shell" "$AUDIT"` with shell=dash (see run_audit). If no `dash` binary
# exists, that is not a shell disagreement -- it is bash's real output being
# diffed against `dash: command not found` (exit 127), and assert_case's own
# "bash and dash disagree" wording could not tell the two apart. That is
# exactly what happened on `tabsii-com/tabsii-platform` PR #952: its
# self-hosted fleet is Amazon Linux 2023, which carries neither a `dash`
# package (`dnf install -y dash` -> "No match for argument: dash") nor a
# usable EPEL9 dash, no `busybox`, nothing else POSIX-compatible enough to
# stand in. Every dash-side comparison failed with exit 127, and this
# self-test reported it as "bash and dash disagree" -- a false positive
# indistinguishable in its own output from a genuine regression in
# interpreter-audit.sh, on an environment where dash had never actually run.
#
# Fix, in two parts, matching AGENTS.md section 6's own convention
# ("'Could not determine' is a different fact from 'found a real advisory'"):
#
#   1. `require_real_dash()` below refuses to run a single case unless `dash`
#      genuinely exists AND executes -- distinct wording, distinct exit code
#      (2), so this can never again be misread as a caught regression. This
#      holds regardless of where the fix in part 2 is deployed or how it
#      later changes -- the self-test protects its own denominator itself.
#   2. `release-guards.yml`'s self-test step now runs this script inside a
#      `debian:stable` container, which ships a real `dash` as `/bin/sh` by
#      default -- so on the runner fleets that actually invoke this (both
#      `ubuntu-latest` and the self-hosted AL2023 fleet), part 1's guard is
#      normally a no-op that never fires, and the comparisons below are
#      against a genuine second shell everywhere, not just on Debian-family
#      hosts. See that workflow's own comment for why a container instead of
#      a package-manager install attempt (the AL2023 fleet has no dash in any
#      of its repos to install from).
#
# Exit 0 = every case behaves as specified, and at least one comparison ran.
# Exit 1 = a regression was found in a comparison that DID run.
# Exit 2 = could not verify: no working `dash` in this environment, or (as a
#          structural belt-and-suspenders) zero comparisons ran for any other
#          reason. Never treat 2 as a pass -- it means this self-test proved
#          nothing, the same distinction interpreter-audit.sh itself already
#          makes for "could not examine" vs. "examined, matching" (#1413).
#
# Run: sh scripts/interpreter-audit.test.sh

set -u
(set -o pipefail) 2>/dev/null && set -o pipefail || true

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
AUDIT="$REPO_ROOT/scripts/interpreter-audit.sh"

# require_real_dash -- fail loudly and distinctly (exit 2, not 1) if this
# environment has no dash a comparison can actually run against. See the
# header above (#1652): the alternative is every "$shell"=dash invocation
# below hitting `command not found` and being read as a real disagreement.
require_real_dash() {
  if ! command -v dash >/dev/null 2>&1; then
    printf 'interpreter-audit.test.sh: CANNOT VERIFY -- no "dash" binary in this environment.\n' >&2
    printf 'This is NOT "bash and dash disagree" (a regression) -- it is this self-test\n' >&2
    printf 'having no real second shell to compare bash against at all. Do not read the\n' >&2
    printf 'CI wiring as broken from this alone; read whether it is running where a real\n' >&2
    printf 'dash exists (#1652 -- release-guards.yml runs this inside a debian:stable\n' >&2
    printf 'container for exactly this reason). Locally: apt-get/brew install dash, or\n' >&2
    printf 'run this inside such a container.\n' >&2
    exit 2
  fi
  if ! dash -c 'exit 0' >/dev/null 2>&1; then
    printf 'interpreter-audit.test.sh: CANNOT VERIFY -- "dash" exists but does not run\n' >&2
    printf '`dash -c '"'"'exit 0'"'"'` successfully. Same class as a missing binary (#1652) --\n' >&2
    printf 'this is not a caught regression, it is an unusable second shell.\n' >&2
    exit 2
  fi
}
require_real_dash

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
CASES_RUN=0

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

# make_script_fixture <dir> <target-name> <caller-name> <caller-line>
#
# Same disposable git repo as make_fixture, but the interpreter mismatch (or
# the deliberately-not-a-mismatch prose) lives inside a SECOND file under
# scripts/ -- a script invoking another script -- not inside the workflow
# YAML. This is the shape #1681 closes: every prior version of this audit
# read only `.github/workflows/*.yml`, so a script-to-script invocation was
# completely outside what it examined regardless of whether the interpreter
# and shebang agreed. The workflow file here carries a harmless no-op step
# (WF_DIR must hold at least one file, but the workflow itself contributes
# no invocations to count).
make_script_fixture() {
  dir=$1
  target_name=$2
  caller_name=$3
  caller_line=$4
  mkdir -p "$dir/.github/workflows" "$dir/scripts"
  (
    cd "$dir" || exit 1
    git init -q
    git config user.email test@example.invalid
    git config user.name test
    printf '#!/usr/bin/env bash\necho hi\n' >"scripts/${target_name}.sh"
    chmod +x "scripts/${target_name}.sh"
    {
      printf '#!/usr/bin/env sh\n'
      printf '%s\n' "$caller_line"
    } >"scripts/${caller_name}.sh"
    chmod +x "scripts/${caller_name}.sh"
    {
      echo 'name: w'
      echo 'on: push'
      echo 'jobs:'
      echo '  j:'
      echo '    runs-on: ubuntu-latest'
      echo '    steps:'
      echo '      - run: echo noop'
    } >.github/workflows/w.yml
    git add -A
    git commit -q -m fixture
  )
}

# join_lines <line1> <line2> ... -- prints each argument on its own line,
# newline-joined. POSIX-portable way to build a multi-line string without
# the bashism `$'"'"'...'"'"'` (this test script runs under real `sh`/dash).
join_lines() {
  for _l in "$@"; do
    printf '%s\n' "$_l"
  done
}

# make_script_fixture_multiline <dir> <target-name> <caller-name> <caller-body>
#
# Same shape as make_script_fixture, but the caller script'"'"'s body is
# multiple lines (build with join_lines) rather than one `run_line` -- needed
# to exercise a heredoc, which by definition spans more than one physical
# line (#1804).
make_script_fixture_multiline() {
  dir=$1
  target_name=$2
  caller_name=$3
  caller_body=$4
  mkdir -p "$dir/.github/workflows" "$dir/scripts"
  (
    cd "$dir" || exit 1
    git init -q
    git config user.email test@example.invalid
    git config user.name test
    printf '#!/usr/bin/env bash\necho hi\n' >"scripts/${target_name}.sh"
    chmod +x "scripts/${target_name}.sh"
    {
      printf '#!/usr/bin/env sh\n'
      printf '%s\n' "$caller_body"
    } >"scripts/${caller_name}.sh"
    chmod +x "scripts/${caller_name}.sh"
    {
      echo 'name: w'
      echo 'on: push'
      echo 'jobs:'
      echo '  j:'
      echo '    runs-on: ubuntu-latest'
      echo '    steps:'
      echo '      - run: echo noop'
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

  CASES_RUN=$((CASES_RUN + 1))

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

# --- #1681: script-to-script invocations, invisible before this round -----
#
# The concrete miss this class produced:
# `scripts/branch-health-plan-only-detection.test.sh` (#1582) invoked its
# target with an explicit `sh` prefix the target's own `bash` shebang did
# not tolerate, and this audit reported `mismatched: 0` throughout because
# it never read scripts/*.sh at all -- only .github/workflows/*.yml. That
# specific call site is fixed at the source now (its own fix predates this
# round), so it cannot serve as fail-first evidence any more; the case below
# is a deliberately-constructed equivalent: a caller script invoking a
# bash-shebang target via bare `sh`, inside scripts/, with nothing in any
# workflow file naming either script.

# MUST be caught: this is exactly the shape this section exists to close.
d="$WORK/script-to-script-mismatch"
make_script_fixture "$d" "inner" "outer" "sh scripts/inner.sh"
assert_case "script-to-script: outer.sh invokes bash-shebang inner.sh via sh" "$d" 1 1 "MISMATCH" ""

# MUST be caught, in the "could not examine" state: the quoted-variable
# target shape (#1681's own real finding in scripts/shared-sync.sh, fixed in
# this same round) is exactly as unresolvable from a script body as it is
# from a workflow's run: line -- counted, never silently dropped.
d="$WORK/script-to-script-quoted"
make_script_fixture "$d" "inner" "outer" 'TARGET_DIR=.; sh "$TARGET_DIR/scripts/inner.sh"'
assert_case "script-to-script: quoted variable target is UNPARSEABLE, not dropped" "$d" 1 1 "COULD NOT EXAMINE" "MISMATCH"

# MUST be caught, in the "could not examine" state: #1809's own reproduction
# -- a script argument built via a command substitution that itself takes an
# argument, `sh "$(dirname "$0")/inner.sh"`, has internal whitespace (the
# space inside `dirname "$0"`) BEFORE the tokenizer's own first whitespace
# boundary. The naive `[^ \t]+` token extraction stops at that internal
# space, capturing only `"$(dirname` -- a fragment that neither ends in
# `.sh` (CLEAN) nor itself contains `.sh` (the quoted-variable-target
# UNPARSEABLE branch immediately above, whose token has NO internal
# whitespace and so is never truncated this way). Before this fix that
# fragment matched neither branch and the whole invocation was dropped --
# not examined, not mismatched, not "could not examine" -- the exact silent
# fourth state this audit's own header invariant forbids.
d="$WORK/script-to-script-cmdsub-whitespace"
make_script_fixture "$d" "inner" "outer" 'sh "$(dirname "$0")/inner.sh"'
assert_case "script-to-script: command-substitution-with-internal-whitespace target is UNPARSEABLE, not dropped" "$d" 1 1 "COULD NOT EXAMINE" "MISMATCH"

# MUST be caught, in the "could not examine" state: #1826's own reproduction
# -- the POSIX-portable backtick sibling of the `$()` shape immediately
# above, `sh `dirname "$0"`/inner.sh`. Same naive `[^ \t]+` token extraction,
# same internal-whitespace truncation (the space inside `dirname "$0"`), but
# the captured fragment is `` `dirname `` -- balanced quotes, balanced
# parens, ONE unmatched backtick. `token_is_truncated()` before the
# Tenth-pass fix counted only `"`, `'`, `(` and `)`, so this fragment read as
# a syntactically complete word and the new UNPARSEABLE branch never fired --
# reproducing #1809's own silent fourth state under different quoting syntax,
# inside the very fix that closed #1809.
d="$WORK/script-to-script-cmdsub-backtick"
make_script_fixture "$d" "inner" "outer" 'sh `dirname "$0"`/inner.sh'
assert_case "script-to-script: backtick-command-substitution-with-internal-whitespace target is UNPARSEABLE, not dropped" "$d" 1 1 "COULD NOT EXAMINE" "MISMATCH"

# MUST be caught, in the "could not examine" state: #1828's own reproduction
# -- a backslash-escaped space INSIDE the script-argument path itself
# (`sh scripts/verify\ sub\ dir/inner.sh`), not inside a quoted or
# substituted expression the way #1809 and #1826 were. Same naive
# `[^ \t]+` token extraction, same internal-whitespace truncation (the
# escaped space), but the captured fragment (`scripts/verify\`) carries none
# of `token_is_truncated()`'s five tracked signals (no unbalanced `"`, `'`,
# `(`/`)`, or backtick) -- so it fell through uncounted a THIRD time, inside
# the very fix that had just closed #1826. This is the case that motivated
# replacing the whole enumerated-character approach with shell_word_length()
# (see the "Eleventh-pass" header section) rather than adding a sixth signal.
d="$WORK/script-to-script-escaped-space"
make_script_fixture "$d" "inner" "outer" 'sh scripts/verify\ sub\ dir/inner.sh'
assert_case "script-to-script: backslash-escaped-space target is UNPARSEABLE, not dropped" "$d" 1 1 "COULD NOT EXAMINE" "MISMATCH"

# MUST be caught, in the "could not examine" state: shell_word_length()'s own
# fixture matrix companion -- an escaped space combined with a command
# substitution in the SAME argument, to check the two constructs compose
# rather than one masking a regression in the other.
d="$WORK/script-to-script-escaped-space-and-cmdsub"
make_script_fixture "$d" "inner" "outer" 'sh "$(dirname "$0")"/sub\ dir/inner.sh'
assert_case "script-to-script: escaped space plus command substitution in one target is UNPARSEABLE, not dropped" "$d" 1 1 "COULD NOT EXAMINE" "MISMATCH"

# MUST NOT be caught: a script body is full of prose that LOOKS like an
# invocation and is not one -- usage comments, echo/printf help text,
# test-scenario labels (real examples in this file's own header: biffo.sh's
# `echo "... sh scripts/shared-sync.sh ..."` help text,
# interpreter-audit.test.sh's own `assert_case "matrix: bash
# scripts/${name}.sh ..."` labels). A guard that cannot tell those from code
# is red on every script in this repo, which trains people to stop reading
# it -- exactly the failure this fix must not introduce.
d="$WORK/script-to-script-prose-quoted"
make_script_fixture "$d" "inner" "outer" 'echo "for example: sh scripts/inner.sh --flag"'
assert_case "script-to-script: sh/bash inside a quoted echo string is not an invocation" "$d" 0 0 "" "MISMATCH"

# MUST NOT be caught: a full-line doc comment naming the exact mismatched
# shape is not code either.
d="$WORK/script-to-script-comment"
make_script_fixture "$d" "inner" "outer" "# Run: sh scripts/inner.sh --flag"
assert_case "script-to-script: a doc comment naming sh scripts/inner.sh is not an invocation" "$d" 0 0 "" "MISMATCH"

# --- #1804: heredoc-body prose false-MISMATCHed as code -------------------
#
# is_quoted_before()/strip_unquoted_comment() track shell quoting only per
# LOGICAL line -- correct for the quoted-echo-prose shapes above, but a
# heredoc body carries no shell quoting of its own (it is raw text between
# an opener and its terminator), so every line inside one used to start
# "unquoted" and any `sh <name>.sh` / `bash <name>.sh`-shaped substring in it
# read as code. Reproduced live against this exact PR's script before the
# fix: a heredoc-based usage example naming a real bash-shebang script
# produced a false MISMATCH, exit 1 (fleet-filed issue #1804). Each case
# below is one of the three heredoc-terminator quoting shapes named in that
# issue's fix request.

# MUST NOT be caught: bare, unquoted terminator (`<<EOF2`) -- the exact shape
# from #1804's own reproduction.
d="$WORK/heredoc-bare"
body=$(join_lines \
  'cat <<EOF2' \
  'Usage example:' \
  '  sh scripts/inner.sh --now' \
  'EOF2')
make_script_fixture_multiline "$d" "inner" "outer" "$body"
assert_case "heredoc: bare <<EOF2 terminator, usage prose inside" "$d" 0 0 "" "MISMATCH"

# MUST NOT be caught: single-quoted terminator (`<<'STUB'`).
d="$WORK/heredoc-single-quoted"
body=$(join_lines \
  "cat <<'STUB'" \
  'Usage example:' \
  '  sh scripts/inner.sh --now' \
  'STUB')
make_script_fixture_multiline "$d" "inner" "outer" "$body"
assert_case "heredoc: single-quoted <<'STUB' terminator, usage prose inside" "$d" 0 0 "" "MISMATCH"

# MUST NOT be caught: double-quoted terminator (`<<"JSON"`).
d="$WORK/heredoc-double-quoted"
body=$(join_lines \
  'cat <<"JSON"' \
  'Usage example:' \
  '  sh scripts/inner.sh --now' \
  'JSON')
make_script_fixture_multiline "$d" "inner" "outer" "$body"
assert_case 'heredoc: double-quoted <<"JSON" terminator, usage prose inside' "$d" 0 0 "" "MISMATCH"

# MUST NOT be caught: tab-indented terminator (`<<-INDENT`), where only
# leading TABS (never spaces) are stripped before comparing against the
# terminator -- the fourth real shell heredoc shape, not just the three the
# issue names verbatim (same "class, not instance" reasoning the fix itself
# documents).
TAB=$(printf '\t')
d="$WORK/heredoc-dash-indented"
body=$(join_lines \
  'cat <<-INDENT' \
  "${TAB}sh scripts/inner.sh --now" \
  "${TAB}INDENT")
make_script_fixture_multiline "$d" "inner" "outer" "$body"
assert_case "heredoc: <<-INDENT with tab-indented body and terminator" "$d" 0 0 "" "MISMATCH"

# MUST be caught, both of them: a real mismatched invocation BEFORE a
# heredoc opens and another AFTER it closes, in the same file -- the
# regression this fixture guards against is heredoc-tracking state either
# never engaging (falls back to the pre-#1804 bug) or getting stuck open
# forever (a new bug the fix itself could introduce, silently exempting all
# code after the first heredoc in any script). Exactly 2 invocations
# expected, not 3 -- the prose line inside the heredoc body must stay
# uncounted.
d="$WORK/heredoc-surrounding-code-still-scanned"
body=$(join_lines \
  'sh scripts/inner.sh --before' \
  'cat <<EOF' \
  '  sh scripts/inner.sh --prose-inside-heredoc-not-real' \
  'EOF' \
  'sh scripts/inner.sh --after')
make_script_fixture_multiline "$d" "inner" "outer" "$body"
assert_case "heredoc: real invocations before and after are still caught, body is not" "$d" 1 2 "MISMATCH" ""

# MUST be caught: a real invocation sharing its physical line with the
# heredoc opener itself (piping a heredoc into the invoked command's stdin)
# -- the opener must not retroactively exempt the very line it appears on.
d="$WORK/heredoc-opener-shares-line-with-real-invocation"
body=$(join_lines \
  'sh scripts/inner.sh --now <<EOF' \
  '  prose inside, not a real invocation: sh scripts/inner.sh nopeflag' \
  'EOF')
make_script_fixture_multiline "$d" "inner" "outer" "$body"
assert_case "heredoc: real invocation on the opener's own line is still caught" "$d" 1 1 "MISMATCH" "nopeflag"

# --- #1817: a plain (non `-`) heredoc's terminator gets stuck open when it --
# is indented with SPACES, silently un-scanning the rest of the file -------
#
# detect_heredoc()'s original closing check only stripped leading TABS, and
# only for `<<-`. A heredoc opened WITHOUT `-` whose terminator is indented
# with SPACES -- the ordinary shape for a heredoc inside an indented shell
# function, or a YAML `run: |` block whose own block-scalar indentation
# stripping makes an in-source-indented terminator line up as a real,
# flush-left terminator at runtime -- never matched `check_line ==
# heredoc_term`, so `in_heredoc` never cleared and every physical line to
# EOF was silently excluded, no error, no "could not examine" bump.
# Reproduced live against this exact PR's own required deploy/destroy
# workflows (fleet-filed issue #1817, independently gating PR #1782).

# MUST NOT be caught: prose inside a heredoc body still excluded when the
# terminator is SPACE-indented rather than flush-left or tab-indented.
d="$WORK/heredoc-space-indented"
body=$(join_lines \
  'cat <<INDENT' \
  '  sh scripts/inner.sh --now' \
  '  INDENT')
make_script_fixture_multiline "$d" "inner" "outer" "$body"
assert_case "heredoc: <<INDENT (no dash) with space-indented body and terminator" "$d" 0 0 "" "MISMATCH"

# MUST be caught, both of them: the exact shape #1817 reproduced -- a real
# invocation BEFORE a plain heredoc whose terminator is SPACE-indented, and
# another AFTER it, in the same file. Before the fix, `in_heredoc` never
# cleared at the indented terminator, so the second invocation (and
# everything else to EOF) went completely unexamined -- 1 invocation found,
# not 2, with exit 0 masking a real MISMATCH. Exactly 2 expected here too,
# not 3 -- the prose line inside the body must stay uncounted.
d="$WORK/heredoc-space-indented-surrounding-code"
body=$(join_lines \
  'sh scripts/inner.sh --before' \
  'cat <<EOF' \
  '  sh scripts/inner.sh --prose-inside-heredoc-not-real' \
  '  EOF' \
  'sh scripts/inner.sh --after')
make_script_fixture_multiline "$d" "inner" "outer" "$body"
assert_case "heredoc: <<EOF (no dash) with space-indented terminator still closes, before/after still caught" "$d" 1 2 "MISMATCH" ""

# --- #1817: two further ways into the same stuck-open state, found by -----
# attacking this PR's own #1804 heredoc-exclusion fix rather than trusting --
# its green self-test -------------------------------------------------------
#
# detect_heredoc() ran against the RAW physical line, before
# strip_unquoted_comment() ever saw it -- so a `#`-comment merely NAMING a
# heredoc opener in prose (this file's own header comments do exactly that,
# e.g. "`<<TOKEN`") was read as a real opener, whose terminator ("TOKEN")
# then never legitimately appears alone on a line -- stuck open to EOF, a
# second independent path into the identical failure this section's first
# two cases close. Reproduced live: this repo's OWN scripts/interpreter-audit.sh
# hit this on its own header prose before the fix.

# MUST NOT be caught, and must not swallow what follows: a comment merely
# naming a heredoc-opener shape in prose is not a real opener.
d="$WORK/heredoc-opener-inside-comment-not-real"
body=$(join_lines \
  '# usage example: `cat <<TOKEN` opens a heredoc' \
  'sh scripts/inner.sh --after-comment')
make_script_fixture_multiline "$d" "inner" "outer" "$body"
assert_case "heredoc: opener-shaped text inside a # comment does not open a fake heredoc" "$d" 1 1 "MISMATCH" ""

# MUST NOT be caught, and must not swallow what follows: heredoc-opener-
# shaped text sitting inside an already-quoted shell string literal (not a
# comment) is data, not a real opener either -- the same
# is_quoted_before()-based quote-parity check `process()` already applies to
# `sh`/`bash` matches, now also applied to detect_heredoc()'s own candidate
# matches. Reproduced live: this repo's OWN scripts/interpreter-audit.test.sh
# hit this on its own 'cat <<EOF2' fixture-building string literal (see the
# "heredoc: bare <<EOF2 terminator" case near the top of this section) before
# the fix -- the comment fix alone (case above) was not sufficient, this is a
# genuinely THIRD, independent path into the same stuck-open state.
d="$WORK/heredoc-opener-inside-quoted-string-not-real"
body=$(join_lines \
  "echo 'cat <<EOF2'" \
  'sh scripts/inner.sh --after-quoted-string')
make_script_fixture_multiline "$d" "inner" "outer" "$body"
assert_case "heredoc: opener-shaped text inside a quoted string literal does not open a fake heredoc" "$d" 1 1 "MISMATCH" ""

# --- Must still hold: this repo's own real workflows -----------------------
# Not pinned to a fixed count (that grows as this repo's workflows do) —
# only to the properties #1625 cares about: nothing mismatched, nothing
# left unexamined, exit 0.
CASES_RUN=$((CASES_RUN + 1))
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

# The denominator, printed unconditionally before any verdict -- same
# discipline interpreter-audit.sh's own header requires of itself (#1413): a
# guard about a check that never ran must not itself report a pass having
# run zero comparisons. require_real_dash() above should make CASES_RUN=0
# unreachable, but that is a claim worth checking rather than trusting, so
# it is enforced here structurally too rather than only by that earlier exit.
echo
printf 'interpreter-audit.test.sh: %s comparison(s) actually run (bash vs. real dash)\n' "$CASES_RUN"

if [ "$CASES_RUN" -eq 0 ]; then
  echo "interpreter-audit.test.sh: CANNOT VERIFY -- zero comparisons ran. A denominator" >&2
  echo "of zero is not a pass; something above returned before any assert_case (or the" >&2
  echo "real-repo check) executed." >&2
  exit 2
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "interpreter-audit.test.sh: $FAILURES of $CASES_RUN check(s) failed."
  exit 1
fi

echo "interpreter-audit.test.sh: all $CASES_RUN check(s) passed."
exit 0
