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
#   <PR_BODY> <PR_CLOSING_ISSUES json> <PR_FILES space-separated> [<PR_COMMITS json>]
#
# The 7th arg is new (#1732): every case before it hardcoded PR_COMMITS='[]',
# which is exactly why the commit-message gap this file now also covers went
# untested by this harness for as long as it did -- the corpus this file
# exercised never included the one document GitHub's squash-merge actually
# reads. Defaults to '[]' so every existing call site (6 args) is unaffected.
_assert_case() {
  label=$1
  expect_ok=$2
  expect_tag=$3
  body=$4
  closing_json=$5
  files=$6
  commits=${7:-[]}

  CASES=$((CASES + 1))

  actual=$(
    PR_BODY="$body" PR_TITLE='' PR_COMMITS="$commits" \
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

# ── #1732: closingIssuesReferences is PR-BODY-scoped, and cannot see a hit ──
# ── that lives only in a COMMIT MESSAGE -- yet that is the document this  ──
# ── repo's squash-merge actually composes (squash_merge_commit_message =  ──
# ── COMMIT_MESSAGES, confirmed via `gh api repos/.../branches/dev/protection`).
#
# All four cases below pass PR_BODY containing the SAME phrase wrapped in a
# markdown code span, mirroring PR #1730's real body (`gh pr view 1730 --json
# body`) -- GitHub's PR-body linker correctly ignores it there, so
# closingIssuesReferences reads [] (empty) in every case, exactly as it did
# for #1730. The distinguishing fact is what the COMMIT message says, since a
# git commit message has no markdown semantics: a backtick there is two
# literal characters, not a code-span delimiter, and GitHub's push-based
# closing-keyword scan (independent of closingIssuesReferences) reads it raw.
#
# Real instance: PR #1730 (`gh pr view 1730 --json body,commits,mergeCommit`;
# squash commit read via `gh api repos/keiranholloway/biffo-template/commits/
# a11a5b7e26478efb2274205e2a1203c16abaabce --jq .commit.message`) squash-
# merged with closingIssuesReferences==[] and a commit message containing the
# bare (unprotected) phrase "fix #1664" -- which closed #1664 1 second after
# merge, per the issue timeline.

# Real: PR #1730's own actual body and squash commit message (see provenance
# above). Both are fixture FILES, not inline literals -- the real text
# contains apostrophes and backticks that are painful and error-prone to
# single-quote-escape faithfully in POSIX sh; a file sidesteps that entirely
# without paraphrasing a single character of the captured text.
_assert_case \
  'PR #1730 real shape: PR body backtick-protects "fix #1664" (ground truth stays []), but the commit message does not' \
  false 'commit-ground-truth-mismatch' \
  "$(cat "$HERE/check-closing-keywords-fixtures/pr-1730-real-body.txt")" \
  '[]' \
  'scripts/check-closing-keywords.mjs' \
  "$(cat "$HERE/check-closing-keywords-fixtures/pr-1730-real-commit.json")"

# Real corpus: a LATER commit on dev narrates the #1021 incident, quoting
# `Does not close #1021` inside backticks. That quoted example is itself a
# NEGATED closing keyword (check 2's territory) -- and since a commit message
# has no markdown semantics, the backticks around it are literal, not
# protection, so check 2's own raw (un-stripped) scan of this commit document
# now catches it directly as `negated-keyword`, one check earlier than the
# new commit-ground-truth check below would have. Confirms the SAME `code:
# false` fix (#1732 part (a): the guard's own lexical scan was blind to
# backtick-wrapped commit text) independently repairs check 2, not only the
# new check 3b. Captured via:
#   git log origin/dev --all --format='%B' | sed -n '20329p'
_assert_case \
  'real corpus: a negation quoted in backticks inside a COMMIT is not protected there the way it is in a PR body' \
  false 'negated-keyword' \
  'Unrelated PR body, no ground truth for this issue at all.' \
  '[]' \
  'docs/practices.md' \
  "$(cat "$HERE/check-closing-keywords-fixtures/corpus-recurrence-line-commit.json")"

# Synthetic (models the mechanism directly): a closing directive wrapped in
# backticks -- as an author familiar with THIS guard's PR-body behaviour would
# reasonably write, expecting the same protection -- sitting ONLY in the
# commit message. Git commit messages have no markdown semantics, so the
# backticks are literal and do not protect it there the way they would in a
# PR body.
_assert_case \
  'synthetic: a backtick-quoted "Closes #99" in a COMMIT message is NOT protected the way it would be in the PR body' \
  false 'commit-ground-truth-mismatch' \
  'Refs #99 only, nothing deliberate here.' \
  '[]' \
  'cli/src/lib/a.ts' \
  "$(cat "$HERE/check-closing-keywords-fixtures/synthetic-backtick-commit.json")"

# Real corpus: an ordinary, idiomatic `closes #NNNN` trailer on its own line
# in a commit body -- the overwhelmingly common real shape (hundreds of
# examples per the corpus grep above) -- must keep passing on an ordinary
# path with no ground truth, exactly as it always has. Captured via:
#   git log origin/dev --all --format='%B' | sed -n '14448,14454p'
_assert_case \
  'real corpus: a genuine own-line commit trailer ("closes #1413") still PASSES on an ordinary path' \
  true 'no-deploy-only-paths' \
  'Refs #1413 elsewhere, nothing to reconcile in the body.' \
  '[]' \
  'cli/src/lib/a.ts' \
  "$(cat "$HERE/check-closing-keywords-fixtures/corpus-trailer-commit.json")"

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
