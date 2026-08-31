#!/usr/bin/env sh
#
# Guard for #1762 / biffo-template#1731: PR #1760 added `--locked` to every
# `uv sync` call site it enumerated by hand -- 5 in
# _skeletons/plugin-template/.github/workflows/ci.yml and 1 in
# _skeletons/sibling-template/.github/workflows/ci.yml -- but missed a 6th
# call site in the SAME plugin skeleton:
# _skeletons/plugin-template/.github/workflows/release.yml:93, which stayed
# bare `uv sync --all-groups`. release.yml fires on every `v*` tag push and
# is the workflow that actually builds and publishes the release artefact
# (not a side path), so a `pyproject.toml`/`uv.lock` drift at tag time still
# re-resolved and released silently -- exactly the symptom #1731 was filed
# against, surviving inside the very PR whose title claimed to close it.
#
# CAUSE (named in the second prosecutor verdict against PR #1760, and in
# #1762 itself): the fix hand-enumerated call sites across two skeletons'
# workflow files rather than making the omission structurally impossible.
# That is guessable-around by hand every time a workflow gains a new `uv
# sync` step. This script closes the CLASS rather than the one instance: it
# globs every workflow file under _skeletons/**/.github/workflows/** and
# fails if ANY real `run: uv sync` line there lacks `--locked`, rather than
# naming call sites -- so a 7th one added tomorrow is caught automatically
# instead of requiring another hand-audit.
#
# This is a *.test.sh guard, auto-discovered and run by
# scripts/guard-self-test-wiring.sh if nothing else wires it into CI first
# (see that script's own docstring for why an unwired guard still runs
# rather than silently contributing nothing).
#
# POSIX sh; validated with BOTH `dash -n` and `bash -n` (no bashisms used).
#
# Run: sh scripts/uv-sync-locked.test.sh

set -u

FAILURES=0
CASES=0

# _is_call_site <line> -- true (exit 0) iff this is a REAL (non-comment)
# `run:` step invoking `uv sync`. A comment line that merely MENTIONS
# `uv sync` (there are several in this repo, documenting exactly this
# history -- e.g. "plain `uv sync` silently RE-RESOLVES when...") must
# never be mistaken for a call site, the same discipline
# guard-self-test-wiring.sh applies to its own guard-name scan.
_is_call_site() {
  line=$1
  stripped=$(printf '%s' "$line" | sed 's/^[[:space:]]*//')
  case $stripped in
    '#'*) return 1 ;;
  esac
  case $stripped in
    *'run: uv sync'*) return 0 ;;
  esac
  return 1
}

# _is_violation <line> -- true (exit 0) iff this is a real call site (per
# _is_call_site) that does not carry `--locked` anywhere on the line.
_is_violation() {
  line=$1
  if _is_call_site "$line"; then
    case $line in
      *'--locked'*) return 1 ;;
    esac
    return 0
  fi
  return 1
}

# ── Case table, proving the classifier itself before trusting it against
# the real corpus below. Every "real" case is pasted verbatim from this
# repo's own tracked files at the commit that introduced/fixed #1762 (see
# provenance comment beside each); the one "synthetic" case is marked as
# such rather than presented as captured.

_assert_case() {
  label=$1
  expect=$2 # "catch" or "pass"
  line=$3

  CASES=$((CASES + 1))

  if _is_violation "$line"; then
    actual=catch
  else
    actual=pass
  fi

  if [ "$actual" = "$expect" ]; then
    echo "PASS: $label"
  else
    echo "FAIL: $label (expected $expect, got $actual)"
    FAILURES=$((FAILURES + 1))
  fi
}

# ── must-catch ──────────────────────────────────────────────────────────

# Real: the exact missed call site this issue is filed over, before this
# fix. Captured via:
#   git show pr1760:_skeletons/plugin-template/.github/workflows/release.yml \
#     | sed -n '93p'
_assert_case \
  'real (pre-fix): release.yml:93 bare "uv sync --all-groups"' \
  catch \
  '      - run: uv sync --all-groups'

# Synthetic: the barest possible form, no flags at all -- proves the check
# is keyed only to the absence of --locked, not to "--all-groups"
# specifically. No real call site in this repo is this bare today.
_assert_case \
  'synthetic: bare "uv sync", no flags at all' \
  catch \
  '      - run: uv sync'

# ── must-NOT-catch ──────────────────────────────────────────────────────

# Real: git show pr1760:_skeletons/plugin-template/.github/workflows/ci.yml \
#   | sed -n '51p'
_assert_case \
  'real: ci.yml:51 correctly-locked call site' \
  pass \
  '      - run: uv sync --all-groups --locked'

# Real: git show pr1760:_skeletons/plugin-template/.github/workflows/release.yml \
#   | sed -n '43p' -- an UN-indented comment MENTIONING uv sync, not a call
# site. Exactly the shape that would false-positive a naive whole-line
# `grep 'uv sync'`.
_assert_case \
  'real: release.yml:43 unindented comment mentioning uv sync' \
  pass \
  '# "biffo-plugin-sdk dependency" section for what that means for `uv sync`'

# Real: git show pr1760:_skeletons/plugin-template/.github/workflows/ci.yml \
#   | sed -n '45p' -- same shape, indented inside a job.
_assert_case \
  'real: ci.yml:45 indented comment mentioning uv sync' \
  pass \
  '      # there): plain `uv sync` silently RE-RESOLVES when `pyproject.toml`'

# Real: git show pr1760:_skeletons/sibling-template/.github/workflows/ci.yml \
#   | sed -n '246p' -- deeper indent again, different skeleton.
_assert_case \
  'real: sibling ci.yml:246 comment mentioning uv sync, deeper indent' \
  pass \
  '        # services/api, which is the environment `uv sync` installed and so the'

echo
echo "uv-sync-locked case table: ${CASES} case(s), $((CASES - FAILURES)) passed, ${FAILURES} failed."

if [ "$FAILURES" -gt 0 ]; then
  echo "FAIL: the detection logic itself is wrong -- fix _is_violation/_is_call_site before trusting the corpus scan below." >&2
  exit 1
fi

# ── Real scan: every _skeletons/**/.github/workflows/** file ─────────────
#
# Deliberately scoped to _skeletons/ per #1762's own suggested fix -- the
# skeletons are what every plugin/sibling repo is scaffolded FROM, so a gap
# here reproduces into every future repo. The root repo's own
# .github/workflows/ (ci.yml, deploy-app.yml) is not a skeleton and is not
# in scope for this guard.

SKELETON_DIR="_skeletons"

if [ ! -d "$SKELETON_DIR" ]; then
  echo "FAIL: ${SKELETON_DIR}/ does not exist -- the guard has nothing to scan, which is itself the failure this exists to catch." >&2
  exit 1
fi

workflow_files=$(find "$SKELETON_DIR" -path '*/.github/workflows/*' \( -name '*.yml' -o -name '*.yaml' \) 2>/dev/null | sort)

if [ -z "$workflow_files" ]; then
  echo "FAIL: found 0 workflow files under ${SKELETON_DIR}/**/.github/workflows/** -- the glob matched nothing." >&2
  exit 1
fi

violations=""
scanned=0
call_sites=0

for f in $workflow_files; do
  scanned=$((scanned + 1))
  while IFS= read -r line || [ -n "$line" ]; do
    if _is_call_site "$line"; then
      call_sites=$((call_sites + 1))
      if _is_violation "$line"; then
        printed=$(printf '%s' "$line" | sed 's/^[[:space:]]*//')
        violations="${violations}  - ${f}: ${printed}
"
      fi
    fi
  done <"$f"
done

echo
echo "uv-sync-locked scan: ${scanned} workflow file(s) under ${SKELETON_DIR}/, ${call_sites} 'run: uv sync' call site(s) found."

if [ -n "$violations" ]; then
  printf 'FAIL: the following call site(s) are missing --locked:\n%s' "$violations" >&2
  exit 1
fi

if [ "$call_sites" -eq 0 ]; then
  echo "FAIL: 0 call sites found -- either uv sync is genuinely absent from every skeleton workflow (unlikely) or this script's own match logic is broken. Either way, 0 is not a pass." >&2
  exit 1
fi

exit 0
