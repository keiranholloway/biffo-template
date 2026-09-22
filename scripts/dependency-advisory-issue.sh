#!/bin/sh
#
# File or update ONE tracking issue for ONE dependency advisory found on the
# base branch, keyed by advisory ID (#2040).
#
# ## Why a separate, testable script rather than inline workflow shell
#
# Every other scheduled report in this repo (orphan-ratchet-report.yml,
# shared-sync-report.yml, instance-adoption-report.yml,
# distribution-remote-state-report.yml) opens exactly ONE tracking issue per
# run, by one fixed title. This workflow's job is different: a single
# scheduled scan can find MULTIPLE advisories in the same run (#2040's own
# incident was two, on the same evening), and each is its own actionable
# unit that the fleet ranks, builds, prosecutes and merges independently —
# so each needs its OWN issue, not one issue listing several. That is a
# per-advisory loop rather than a single inline block, and a loop calling
# `gh` directly from a `run: |` step cannot be unit-tested without a real
# GitHub repo and a real scheduled trigger. Pulling the per-advisory logic
# into its own script, following this repo's own scripts/*.sh + *.test.sh
# convention, makes the idempotence property provable locally: call it twice
# against the same advisory ID with `gh` stubbed, and see exactly one create
# and one comment, not two creates (#2040's own "Done when" bullet).
#
# ## The search-then-create-or-comment shape
#
# Identical to the pattern every scheduled report above already uses:
# `gh issue list --state open --limit 100 --json number,title`, filtered in
# jq for an EXACT title match, comment if found, create if not. Reused
# verbatim here rather than reinvented, for the same reason
# orphan-ratchet-report.yml reused shared-sync-report.yml's discovery code:
# a second, slightly different implementation of "find or create by title"
# is exactly the kind of drift AGENTS.md's `_extract_detail` story warns
# about.
#
# The title embeds the advisory ID verbatim and nothing else that could
# change between runs (not the severity, not the package version) — so a
# search for the SAME id always finds the SAME issue even if a later run's
# audit reports the same advisory against a bumped-but-still-vulnerable
# version, or a slightly reworded severity label.
#
# ## Usage
#
#   sh scripts/dependency-advisory-issue.sh <ecosystem> <advisory-id> \
#     <package> <severity> <run-url>
#
# `<ecosystem>` is a short label ("npm" / "PyPI") for the issue body, not
# part of the search key — the SAME advisory ID is assumed never to be
# reused across ecosystems (GHSA/PYSEC ids are globally unique by
# construction). Requires `gh` on PATH, authenticated (GH_TOKEN/GITHUB_TOKEN
# in the environment, same as every other report workflow in this repo) and
# `jq`.
#
# Exit 0 on either outcome (created or commented) and prints which one, plus
# the issue number, to stdout — the caller (or this script's own self-test)
# reads that line to prove idempotence rather than re-deriving it from `gh`'s
# own output shape.
#
# POSIX sh (dash-compatible) — no `pipefail`, no arrays.
set -u

if [ "$#" -ne 5 ]; then
  echo "usage: dependency-advisory-issue.sh <ecosystem> <advisory-id> <package> <severity> <run-url>" >&2
  exit 2
fi

ECOSYSTEM="$1"
ADVISORY_ID="$2"
PACKAGE="$3"
SEVERITY="$4"
RUN_URL="$5"

if ! command -v gh >/dev/null 2>&1; then
  echo "::error::dependency-advisory-issue: gh is not on PATH. Cannot file or update a tracking issue." >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "::error::dependency-advisory-issue: jq is not on PATH. Cannot safely match the existing-issue title." >&2
  exit 2
fi

# The advisory ID is the WHOLE search key, by design (#2040's own "keyed by
# advisory ID... update the existing one, never open a second"). Nothing
# else about the finding may vary the title, or two runs reporting the same
# advisory against two different flagged package versions would open two
# issues for one advisory.
TITLE="Dependency advisory ${ADVISORY_ID} found on dev (${ECOSYSTEM}: ${PACKAGE})"

BODY=$(printf '%s\n' \
  "A base-branch dependency-audit scan found advisory **${ADVISORY_ID}** (${SEVERITY}) against \`${PACKAGE}\` (${ECOSYSTEM}) on \`dev\`." \
  "" \
  "This is a Case 2 finding (biffo-template#2040): the advisory is against something already on \`dev\`, not introduced by any open PR — the per-PR diff-aware audit is immune to it by construction, so this scheduled scan is the only place it is ever caught." \
  "" \
  "Run: ${RUN_URL}" \
  "" \
  "Fix by bumping \`${PACKAGE}\` past the advisory in the tree(s) that carry it, the same way any other dependency-audit finding is fixed. This issue is not auto-closed on the next clean run — confirm the bump landed and the advisory no longer appears before closing it.")

existing=$(gh issue list --state open --limit 100 --json number,title \
  --jq "map(select(.title == \"${TITLE}\")) | .[0].number // empty")

if [ -n "$existing" ]; then
  gh issue comment "$existing" --body "$BODY" >/dev/null
  echo "commented: #${existing} (${ADVISORY_ID})"
else
  url=$(gh issue create --title "$TITLE" --body "$BODY")
  num=$(printf '%s' "$url" | grep -oE '[0-9]+$' || true)
  echo "created: #${num:-unknown} (${ADVISORY_ID})"
fi
