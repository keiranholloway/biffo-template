#!/usr/bin/env sh
#
# Proves scripts/check-orphan-ratchet-instance.sh actually closes the gap
# biffo-template#1714's second prosecutor verdict found: nothing in any live
# instance's own PR-time CI could ever find a real orphan, because the only
# step wired in (`sh scripts/biffo.sh check orphan-ratchet`, no args) is a
# self-check that can only ever report zero.
#
# Two real, throwaway git repos stand in for "the template at a pinned
# version" and "a live instance" -- no mocking of git, planCoreUpgrade or
# classify(): the property under test is whether the WRAPPER resolves the
# right tag, clones it, and passes it through to the REAL production check
# logic (`runOrphanRatchetCheck` via `checkCommand`), so a mock of that logic
# would just assert whatever the mock author assumed rather than what the
# real guard actually does with a real diverged tree. This is the same
# "real git, not a mock" discipline scripts/allocate-module-number.test.sh
# uses and for the same reason.
#
# The fixture "instance"'s own scripts/biffo.sh does not exec `npx
# @biffo/cli@<version>` (the real dispatcher) -- that would need a published
# npm version carrying this exact CLI code, which does not exist yet for an
# unreleased change under test. It execs THIS repo's own already-built local
# CLI via tsx directly (BIFFO_TEMPLATE_GIT_URL and this substitution are the
# only two seams the production script exposes for testing, deliberately --
# see check-orphan-ratchet-instance.sh's own header). That still exercises
# the real `checkCommand` -> `runOrphanRatchetCheck` -> `planCoreUpgrade`/
# `classify()` path end to end; only the version-pin-to-npm-package hop
# (scripts/biffo.sh's own concern, unchanged by this PR) is substituted.
#
# Repo-local scratch (never /tmp for the SCRATCH DIR itself -- the fixture
# repos below are a handful of files each, not a copy of a large working
# tree, so cloning them into a temp dir is not the tmpfs-inode hazard
# AGENTS.md warns about; the scratch dir holding the fixtures is kept
# repo-local anyway, matching allocate-module-number.test.sh's own
# precedent).
#
# Run: sh scripts/check-orphan-ratchet-instance.test.sh

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
WRAPPER="$REPO_ROOT/scripts/check-orphan-ratchet-instance.sh"
TSX="$REPO_ROOT/cli/node_modules/.bin/tsx"
CLI_ENTRY="$REPO_ROOT/cli/src/index.ts"

if [ ! -x "$TSX" ]; then
  echo "FAIL: $TSX is not present/executable -- run 'pnpm install' in $REPO_ROOT first (this" >&2
  echo "test exercises the real CLI, not a reimplementation of it)." >&2
  exit 1
fi

WORK=$(mktemp -d "$REPO_ROOT/.check-orphan-ratchet-instance-test-XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

fail=0
report() {
  echo "FAIL: $1" >&2
  fail=1
}

git_c() {
  # A CI runner carries no global git identity; workstation .gitconfig
  # should not leak into the fixture either. Explicit identity every time,
  # same reasoning as allocate-module-number.test.sh's make_fixture().
  git -c user.email=t@example.invalid -c user.name=t "$@"
}

# --- Fixture: "the template" -- a real git repo with a core-manifest.json
# declaring scripts/ template-owned, one real tracked file under scripts/,
# tagged core-v0.1.0. ---------------------------------------------------
make_template_fixture() {
  dir="$1"
  mkdir -p "$dir/scripts"
  (
    cd "$dir" &&
    git init --quiet &&
    printf '%s\n' \
      '{' \
      '  "version": 1,' \
      '  "templateOwned": ["scripts/"],' \
      '  "userOwned": []' \
      '}' > core-manifest.json &&
    echo '#!/usr/bin/env sh' > scripts/real-template-file.sh &&
    # A real instance's own scripts/biffo.sh is TEMPLATE-owned content it
    # received via distribution, not instance-written drift -- so the
    # template fixture must carry the same path too, or the fixture itself
    # (not the code under test) manufactures a false "unsanctioned" finding
    # for every instance fixture below, the same way a real one never would.
    echo '#!/usr/bin/env sh' > scripts/biffo.sh &&
    git add -A &&
    git_c commit --quiet -m 'seed template fixture' &&
    git tag core-v0.1.0
  )
}

# --- Fixture: "an instance" -- a real git repo carrying biffo.core.json
# pinned to 0.1.0, a scripts/biffo.sh stand-in that runs the REAL local CLI,
# and (per case) an unsanctioned file under scripts/ plus an orphan baseline.
# ------------------------------------------------------------------------
make_instance_fixture() {
  dir="$1"
  baseline_count="$2"
  add_unsanctioned="$3"
  mkdir -p "$dir/scripts"
  cat > "$dir/scripts/biffo.sh" <<EOF
#!/usr/bin/env sh
exec "$TSX" "$CLI_ENTRY" "\$@"
EOF
  chmod +x "$dir/scripts/biffo.sh"
  printf '{\n  "version": "0.1.0"\n}\n' > "$dir/biffo.core.json"
  if [ -n "$baseline_count" ]; then
    printf '{\n  "count": %s\n}\n' "$baseline_count" > "$dir/biffo.orphan-baseline.json"
  fi
  if [ "$add_unsanctioned" = "yes" ]; then
    echo '#!/usr/bin/env sh' > "$dir/scripts/fake-unsanctioned-test-1714.sh"
  fi
  (
    cd "$dir" &&
    git init --quiet &&
    git add -A &&
    git_c commit --quiet -m 'seed instance fixture'
  )
}

template_fixture="$WORK/template-fixture"
make_template_fixture "$template_fixture"

# =============================================================================
# 1. FAIL-FIRST: an instance with an unsanctioned file under scripts/, a
#    recorded baseline of 0, checked against the real pinned template ->
#    exits non-zero, names the file, and names the sanctioned-carve-out
#    guidance (or the "belongs upstream" alternative when none is nearby).
# =============================================================================

dirty_instance="$WORK/dirty-instance"
make_instance_fixture "$dirty_instance" 0 yes

out=$(cd "$dirty_instance" && BIFFO_TEMPLATE_GIT_URL="file://$template_fixture" sh "$WRAPPER" 2>&1)
rc=$?

echo "--- dirty instance run (exit $rc) ---"
echo "$out"
echo "--- end ---"

if [ "$rc" -eq 0 ]; then
  report "an instance carrying an unsanctioned scripts/fake-unsanctioned-test-1714.sh, with a" \
    "recorded baseline of 0, was expected to exit non-zero against the real pinned template -- got 0."
fi

case "$out" in
  *fake-unsanctioned-test-1714.sh*) ;;
  *) report "the failure output does not name the actual unsanctioned file (fake-unsanctioned-test-1714.sh) -- an author reading this CI failure would not know what to move." ;;
esac

case "$out" in
  *"core capability"*"belongs upstream"*|*"sanctioned carve-out"*) ;;
  *) report "the failure output does not distinguish 'should be upstream' from 'should be in a carve-out' -- #1714's own Recommendation section requires this." ;;
esac

# =============================================================================
# 2. A clean instance (no unsanctioned files, tree matches the pinned
#    template exactly) -> exits 0.
# =============================================================================

clean_instance="$WORK/clean-instance"
make_instance_fixture "$clean_instance" "" no
# Give the clean instance the SAME tracked file the template ships, so
# oursDir/theirsDir/baseDir agree exactly and classify() has nothing to flag
# -- a genuinely clean tree, not merely one nobody looked at.
cp "$template_fixture/scripts/real-template-file.sh" "$clean_instance/scripts/real-template-file.sh"
( cd "$clean_instance" && git add -A && git_c commit --quiet -m 'match template tree' )

out=$(cd "$clean_instance" && BIFFO_TEMPLATE_GIT_URL="file://$template_fixture" sh "$WRAPPER" 2>&1)
rc=$?

echo "--- clean instance run (exit $rc) ---"
echo "$out"
echo "--- end ---"

if [ "$rc" -ne 0 ]; then
  report "a clean instance (tree matches the pinned template exactly) was expected to exit 0 -- got $rc: $out"
fi

# =============================================================================
# 3. Not an instance at all (no biffo.core.json) -> exit 0, a genuine skip
#    (this is the template itself, or scripts/verify.sh's own local run of
#    THIS repo's gate) -- distinct from "cannot tell" (see the script's own
#    doc comment for why this is 0 rather than 2: the same distinction
#    check-orphan-ratchet.ts already draws between an omitted --instance-dir
#    and one explicitly given but broken).
# =============================================================================

not_instance="$WORK/not-instance"
mkdir -p "$not_instance"
( cd "$not_instance" && git init --quiet && git_c commit --quiet --allow-empty -m seed )

out=$(cd "$not_instance" && sh "$WRAPPER" 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
  report "a checkout with no biffo.core.json was expected to exit 0 (genuine skip, not 'cannot tell') -- got $rc: $out"
fi

# =============================================================================
# 4. A tag that does not exist (instance pinned to a version the template
#    fixture never tagged) -> exit 2, cannot tell, not a false pass.
# =============================================================================

unknown_tag_instance="$WORK/unknown-tag-instance"
make_instance_fixture "$unknown_tag_instance" 0 no
# Overwrite the version to something the template fixture has no tag for.
printf '{\n  "version": "9.9.9"\n}\n' > "$unknown_tag_instance/biffo.core.json"
( cd "$unknown_tag_instance" && git add -A && git_c commit --quiet -m 'bump to untagged version' )

out=$(cd "$unknown_tag_instance" && BIFFO_TEMPLATE_GIT_URL="file://$template_fixture" sh "$WRAPPER" 2>&1)
rc=$?
if [ "$rc" -ne 2 ]; then
  report "an instance pinned to a version with no matching core-v* tag was expected to exit 2 (cannot tell) -- got $rc: $out"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "PASS: instance-mode orphan-ratchet check (real git fixtures, real CLI) --"
echo "      finds a real unsanctioned file and names it plus the upstream/carve-out"
echo "      guidance, passes a genuinely clean instance, skips (exit 0) when it is"
echo "      not an instance at all, and fails closed (exit 2) on a version with no"
echo "      matching template tag."
exit 0
