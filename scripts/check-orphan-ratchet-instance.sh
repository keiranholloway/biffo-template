#!/usr/bin/env sh
#
# The instance-mode caller of the #1026/#1714 orphan-ratchet guard: runs
# `check orphan-ratchet` from an INSTANCE's own PR-time CI, against a real
# template tree, so an unsanctioned file under a template-owned path fails
# the pull request that adds it -- not a scheduled report up to 24h later,
# and not the `biffo core upgrade` that trips over it months after.
#
# ## The gap this closes (biffo-template#1714, second verdict)
#
# `check-orphan-ratchet.ts`'s own self-check step in ci.yml
# (`sh scripts/biffo.sh check orphan-ratchet`, no args) can only ever find
# zero orphans BY CONSTRUCTION when it runs in the template's own CI:
# --instance-dir/--theirs-dir/--base-dir all default to this checkout's own
# root, so oursDir/theirsDir/baseDir are the same tree read three times (see
# that file's doc comment for the proof). That step is ALSO distributed
# verbatim to every instance via the ordinary `biffo core upgrade` three-way
# merge (`.github/` is template-owned in core-manifest.json, carved out only
# for `*.instance.yml`) -- confirmed live: tabsii-platform@origin/dev
# (core 0.301.24) carries the identical step. Once it lands in an instance's
# own ci.yml it is STILL a self-check, comparing the instance to itself,
# because it still runs with no --instance-dir -- so the mere presence of
# ci.yml's guard step in every instance's CI, which the first #1714 remediation
# shipped, does not close the issue: a prosecutor confirmed (2026-08-29, and
# again 2026-09-04) that no live instance had anything in its own PR-time CI
# that could find a real orphan. `orphan-ratchet-report.yml` (the OTHER half
# #1751 shipped) can — it clones every live instance from the template side —
# but only once a day, from the template's schedule, after the
# divergence-creating PR has already merged.
#
# This script is the missing per-PR caller, run FROM the instance's own CI,
# pointed at a REAL template tree instead of the instance's own root. Wire it
# into an instance's ci.yml as a new step (see this repo's own ci.yml for the
# companion step that does so) and the check that used to only ever find
# zero, or find something up to a day late, now blocks the actual PR.
#
# ## Which template tree, and why it is pinned rather than latest dev
#
# `--instance-dir` is this checkout's own root (real content, real
# divergence). `--theirs-dir` and `--base-dir` are BOTH the template at THIS
# instance's own recorded `biffo.core.json` version -- read fresh, not
# `--from-template`'s "latest dev" default `biffo core upgrade` itself uses
# for its target tree. `orphan-ratchet-report.yml`'s own doc comment names
# exactly this as a real improvement left as follow-up ("a tighter
# per-instance baseDir ... is left as follow-up, not invented here"); this is
# that follow-up, applied to both parameters the same way that workflow
# already applies "current template" to both -- one materialized tree, not
# two, so the check's verdict cannot itself drift mid-PR as `dev` moves
# underneath it while the PR is open, and its answer is reproducible from the
# instance's own already-committed state alone.
#
# ## Why a plain `git clone`, not `materializeTemplateAtTag`
#
# `materializeTemplateAtTag` (cli/src/lib/core-template-trees.ts) needs an
# ALREADY-CLONED local `biffo-template` checkout to extract a tag from
# (`git -C <repo> archive ... <tag>`) -- exactly what `biffo core upgrade`
# has via `--template-repo` / `resolveTemplateRoot`, and exactly what an
# instance's CI runner does not have and has no reason to carry. biffo-template
# is a PUBLIC repo (verified: `visibility: public`), so a plain
# `git clone --depth 1 --branch core-v<version>` needs no token and no prior
# checkout -- simpler than reproducing the local-repo precondition
# `materializeTemplateAtTag` assumes, for a caller that never has it.
#
# ## Fail-closed requirements (2 is "cannot tell", never a pass)
#
# - No biffo.core.json: exit 0, a genuine skip, not "cannot tell" -- the same
#   distinction check-orphan-ratchet.ts's own CLI already draws between an
#   OMITTED --instance-dir (self-check mode, a deliberate and meaningful
#   default, exit 0) and one EXPLICITLY given but missing on disk (broken
#   input, exit 2). Every real instance carries biffo.core.json; its absence
#   means this checkout is the template itself (or scripts/verify.sh's own
#   local run of this repo's gate), which is expected, not broken -- there is
#   nothing wrong to report, so there is nothing to fail on. This is what
#   lets this script be called unconditionally, with no caller-side `if`
#   guard: both the ci.yml step and scripts/verify.sh invoke it exactly like
#   every other guard command, and it stays a harmless, honest no-op in the
#   template's own CI and local gate alike.
# - biffo.core.json present but unreadable/versionless: exit 2 -- this IS
#   broken input (an instance that should be checkable but is not).
# - The clone fails (bad network, tag does not exist -- e.g. an instance
#   pinned to a pre-#423 version with no core-v* tags at all): exit 2, naming
#   the tag it tried and that a real, actionable finding needs a template
#   tree it could not get, which is not the same as a clean tree.
# - The underlying `check orphan-ratchet` exit code (0 clean/no-growth,
#   1 real growth over baseline) is propagated verbatim.
#
# ## Testability
#
# `BIFFO_TEMPLATE_GIT_URL` overrides the clone source (default: the real
# biffo-template on GitHub) so scripts/check-orphan-ratchet-instance.test.sh
# can point this at a local, throwaway fixture repo instead of the network --
# same "injectable remote" shape scripts/allocate-module-number.sh already
# uses for its own --git-remote override, for the same reason (a hermetic
# test must not depend on a live network call succeeding).
#
# POSIX sh; validated with BOTH `dash -n` and `bash -n` (no bashisms, no
# `set -o pipefail` -- see scripts/interpreter-audit.sh's own header for why
# that specific option is the recurring trap here).
#
# Run: sh scripts/check-orphan-ratchet-instance.sh

set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

if [ ! -f biffo.core.json ]; then
  echo "check-orphan-ratchet-instance.sh: no biffo.core.json in ${root} -- this checkout is not" >&2
  echo "an instance (biffo-template itself never carries one), so there is nothing to pin a" >&2
  echo "comparison template version to. Skipping; see this script's own doc comment for why" >&2
  echo "this is a genuine skip (exit 0), not a 'cannot tell' (exit 2)." >&2
  exit 0
fi

version=$(node -p "JSON.parse(require('fs').readFileSync('biffo.core.json','utf8')).version" 2>/dev/null || echo '')
if [ -z "$version" ] || [ "$version" = 'undefined' ]; then
  echo "check-orphan-ratchet-instance.sh: biffo.core.json is present but carries no readable" >&2
  echo "'version' field -- cannot resolve which template tag to compare this instance against." >&2
  exit 2
fi

tag="core-v${version}"
template_url="${BIFFO_TEMPLATE_GIT_URL:-https://github.com/keiranholloway/biffo-template.git}"

clone_dir=$(mktemp -d)
cleanup() { rm -rf "$clone_dir"; }
trap cleanup EXIT INT TERM

echo "check-orphan-ratchet-instance.sh: cloning ${template_url} at ${tag} (this instance's own recorded core version) ..."
clone_output=$(git clone --quiet --depth 1 --branch "$tag" "$template_url" "$clone_dir" 2>&1) || {
  echo "check-orphan-ratchet-instance.sh: could not clone ${template_url} at tag ${tag}." >&2
  echo "$clone_output" >&2
  echo "This can mean the tag genuinely does not exist (an instance pinned to a version older" >&2
  echo "than biffo-template#423's core-v* tags), or a transient network failure. Either way," >&2
  echo "there is no template tree to compare this instance against -- cannot tell whether" >&2
  echo "unsanctioned files exist, which is not the same as a clean pass. If the tag genuinely" >&2
  echo "predates core-v* tagging, upgrade this instance (biffo core upgrade) before this check" >&2
  echo "can run at all." >&2
  exit 2
}

label=$(basename "$root")

# Deliberately the SAME clone for both --theirs-dir and --base-dir -- see
# this script's own header for why that is the right call here, not a
# shortcut.
sh scripts/biffo.sh check orphan-ratchet \
  --instance-dir "$root" --theirs-dir "$clone_dir" --base-dir "$clone_dir" --label "$label"
