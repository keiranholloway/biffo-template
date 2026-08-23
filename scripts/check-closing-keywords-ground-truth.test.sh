#!/usr/bin/env sh
#
# Fail-first guard for #1686: scripts/check-closing-keywords.mjs's
# deploy-only-path check silently PASSED a genuine closing-keyword hit
# whenever the changed paths were ordinary, with nothing checking whether
# GitHub's own closingIssuesReferences confirmed the close would actually
# happen. Real instance: merged PR #1680's body read (in context) "This is
# the one-word fix #1664 asked for" -- mid-sentence prose, not a deliberate
# `Closes #N` trailer -- alongside its own explicit `Refs #1664` elsewhere in
# the same body. closingIssuesReferences read totalCount 1 -> #1664 while the
# PR was in that state. assess() returned `ok: true, reason:
# 'no-deploy-only-paths'` (changed files: cli/src/lib/pg-test-db-reaper.test.ts,
# scripts/pg-test-db.sh -- no DEPLOY_ONLY_PREFIXES entry). Release Guards
# reported SUCCESS. Only a human rewording the body before merge kept #1664
# open.
#
# Every case body below is REAL text, not invented: grepped from this repo's
# own `git log --all --format='%B'` (the corpus command is quoted beside each
# one), plus PR #1680's actual body (`gh pr view 1680 --json body`) for the
# case that motivated this file. See the module docstring's "3. Ground
# truth" section in check-closing-keywords.mjs for the full design writeup.
#
# Level of fix: 3 (fail closed), not 1/2 -- the keyword lives in prose an
# author legitimately writes, so intent cannot be derived with certainty or
# made unrepresentable. See that same docstring section for why.
#
# This is a *.test.sh guard, auto-discovered and run by
# scripts/guard-self-test-wiring.sh if nothing else wires it into CI first.
#
# POSIX sh; validated with BOTH `dash -n` and `bash -n` (no bashisms used).
#
# Run: sh scripts/check-closing-keywords-ground-truth.test.sh

set -u

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
RUNNER="$HERE/check-closing-keywords-assess-once.mjs"

FAILURES=0
CASES=0

# _assert_case <label> <expect_ok: true|false> <expect_kind_or_reason>
#   <PR_BODY> <PR_CLOSING_ISSUES json> <PR_FILES space-separated>
_assert_case() {
  label=$1
  expect_ok=$2
  expect_tag=$3
  body=$4
  closing_json=$5
  files=$6

  CASES=$((CASES + 1))

  actual=$(
    PR_BODY="$body" PR_TITLE='' PR_COMMITS='[]' \
    PR_CLOSING_ISSUES="$closing_json" PR_FILES="$files" \
    node "$RUNNER" 2>&1
  )

  ok_field=$(printf '%s' "$actual" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).ok)}catch{console.log("PARSE_ERROR")}})')
  tag_field=$(printf '%s' "$actual" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const r=JSON.parse(d);console.log(r.kind||r.reason||"")}catch{console.log("PARSE_ERROR")}})')

  if [ "$ok_field" = "$expect_ok" ] && [ "$tag_field" = "$expect_tag" ]; then
    echo "PASS: $label"
  else
    echo "FAIL: $label"
    echo "  expected: ok=$expect_ok tag=$expect_tag"
    echo "  actual  : $actual"
    FAILURES=$((FAILURES + 1))
  fi
}

# ── MUST fail: closingIssuesReferences non-empty, no deliberate keyword ────

# Real text: `gh pr view 1680 --json body` (paraphrased down to the load-
# bearing two lines; the full body is much longer). This is the exact shape
# #1686 is filed over.
_assert_case \
  'PR #1680 real shape: mid-sentence "fix #1664" + explicit "Refs #1664" elsewhere' \
  false 'ground-truth-mismatch' \
  'This is the one-word fix #1664 asked for, and it was committed locally.

Refs #1664, #703, #1383' \
  '[{"number":1664}]' \
  'cli/src/lib/pg-test-db-reaper.test.ts scripts/pg-test-db.sh'

# Real text: `git log --all --format='%B' | grep -n "closes #"` line 42929.
_assert_case \
  'real corpus mid-sentence: "That closes #422 by construction..."' \
  false 'ground-truth-mismatch' \
  'version. That closes #422 by construction rather than policing it;' \
  '[{"number":422}]' \
  ''

# Real text: `git log --all --format='%B' | grep -n "close #"` line 29591.
_assert_case \
  'real corpus mid-sentence: "`--fix` exists to close #714 and #715"' \
  false 'ground-truth-mismatch' \
  'The fix is not an exception list. `--fix` exists to close #714 and #715 -- repos' \
  '[{"number":714},{"number":715}]' \
  ''

# Ground truth confirms a close but OUR OWN regex finds nothing at all -- the
# shape a reverse-adjacency or any other lexical miss would produce. This is
# what makes the ground-truth check catch what widening the regex would have
# had to guess at (#1686's own "UNCONFIRMED SECONDARY CLAIM", not reproduced
# or relied on here -- this case does not depend on that claim being true,
# only on closingIssuesReferences disagreeing with our lexical scan for ANY
# reason).
_assert_case \
  'ground truth non-empty, lexical scan finds nothing at all' \
  false 'ground-truth-mismatch' \
  'Totally unrelated prose with no keyword-plus-reference shape in it.' \
  '[{"number":1664}]' \
  ''

# ── MUST NOT fail: deliberate keyword present, or no ground truth ─────────

# Real text: `git log --all --format='%B' | grep -c '^Closes #'` (hundreds).
_assert_case \
  'real corpus trailer, own line: "Closes #1001"' \
  true 'no-deploy-only-paths' \
  'Closes #1001' \
  '[{"number":1001}]' \
  ''

# Real text: `git log --all --format='%B'` line 46852 -- a trailer sentence
# following prose on the SAME physical line, the case that motivated
# splitting on sentence punctuation, not only newlines.
_assert_case \
  'real corpus sentence-boundary trailer: "warnings on both commands. Closes #201."' \
  true 'no-deploy-only-paths' \
  'warnings on both commands. Closes #201.' \
  '[{"number":201}]' \
  ''

# A deliberate close on a deploy-only path is still governed by the EXISTING
# (unchanged) deploy-only-path check -- the ground-truth check does not
# replace it, only closes the gap beside it.
_assert_case \
  'deliberate close on deploy-only path still caught by the existing check' \
  false 'deploy-only-path' \
  'Closes #42' \
  '[{"number":42}]' \
  'infra/main.tf'

# No ground truth available (closingIssuesReferences empty) -- the new check
# must not fire even though the lexical scan finds a mid-sentence hit; this
# is the additive/backward-compatible contract every existing caller (and
# the whole existing vitest suite in cli/src/lib/closing-keywords.test.ts,
# which never passes this field) relies on.
_assert_case \
  'no ground truth: mid-sentence hit alone does not fail' \
  true 'no-deploy-only-paths' \
  'This is the one-word fix #1664 asked for.' \
  '[]' \
  ''

echo
echo "check-closing-keywords ground-truth guard: ${CASES} case(s), $((CASES - FAILURES)) passed, ${FAILURES} failed."

if [ "$CASES" -eq 0 ]; then
  echo "FAIL: 0 cases ran -- the denominator is empty, which is itself the defect this file exists to catch." >&2
  exit 1
fi

if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi

exit 0
